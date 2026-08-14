import * as Crypto from 'expo-crypto';
import {Alert, AppState, Platform} from 'react-native';

import {ApiError} from '@/api/client';
import {
  type ClockInBody,
  type ClockOutBody,
  clockIn,
  clockOut,
  type Entry,
  fixToBody,
} from '@/api/entries';
import type {Membership} from '@/api/me';
import type {Fix} from '@/api/types';
import {formatDistance} from '@/lib/format';
import {getFix, LocationError} from '@/location/fix';
import {onClockedIn, onClockedOut} from '@/location/tracking';
import {useClockStore} from '@/stores/clock';
import {retryable, useOutboxStore} from '@/stores/outbox';

/**
 * The tap that clocks someone in or out — everything between the press and the store write.
 *
 * A plain module rather than a handler inside app/(tabs)/index.tsx, for one reason: every branch
 * below is a way to lose or double-count someone's hours, and none of them can be reached by hand
 * (they need a 5xx mid-request, a mocked fix, a 409, a lost response). Inside the component none
 * of it is reachable without a renderer, and there is none in this repo. The screen keeps what
 * only a screen can have — the busy flag, the sheet, where the message is drawn.
 */

/**
 * What one tap resolved to.
 *
 * `done` means the write is committed *locally* — accepted by the server, or queued with the
 * optimistic entry standing. Either way the screen closes the sheet and the card is already
 * right. `done: false` with a null message is a dialog the worker backed out of: nothing
 * happened, nothing to say, and the sheet stays where it was so the choice is not lost.
 */
export type ClockResult = {done: boolean; message: string | null};

const OK: ClockResult = {done: true, message: null};
const ABORTED: ClockResult = {done: false, message: null};
const NOT_ON_SHIFT: ClockResult = {done: false, message: "You're not on shift."};

// Alert.alert is implemented for exactly two platforms: RN's Alert.js branches on ios/android and
// returns having touched nothing for anything else, and react-native-web replaces the module with
// a literal no-op (`class Alert { static alert() {} }`). Android adds a second way to say nothing:
// while the host is paused the dialog is stashed rather than shown, and the stash is never replayed
// (confirmWeakGps below has the mechanism). In all of those the dialog is not merely ugly, it never
// speaks — so anything waiting on it waits forever. Called rather than hoisted to a module constant
// because AppState.currentState is a per-tap reading, and so both sides are reachable from a test.
const canAlert = () =>
  Platform.OS === 'ios' || (Platform.OS === 'android' && AppState.currentState === 'active');

/** For anything that escapes the contracts below — api() promises only ApiError, getFix() only
 * LocationError, so this is a bug in our own code, shown rather than thrown because a tap handler
 * that rejects leaves the screen with no way to be correct. */
export const UNEXPECTED_ERROR = 'Something went wrong. Please try again.';

// Mirrors MAX_ACCURACY_M in backend/internal/config/config.go (default 100). Hardcoded, and the
// ceiling is the one location/fix.ts names for ANCHOR_RADIUS_M: change the env var and this
// dialog asks the wrong question until an app release ships. Deliberately not moved into fix.ts —
// that file's constants are the ones it uses itself, and nothing there consults accuracy.
// Note fix.ts's UNKNOWN_ACCURACY_M (9999) is above this on purpose: a platform that reports no
// uncertainty radius trips the confirm dialog, which is the honest question to ask.
const MAX_ACCURACY_M = 100;

// Only reached when the server's OUT_OF_RANGE details are unreadable; same value and same ceiling
// as fix.ts's ANCHOR_RADIUS_M.
const DEFAULT_ANCHOR_RADIUS_M = 1000;

// Codes whose answer is about *our view of open/closed*, not about the fix we sent, so the copy
// alone would leave the worker stuck. OPEN_ENTRY_EXISTS and NO_OPEN_ENTRY are the two conflict
// verdicts (httpx/codes.go). UNKNOWN has two sources, and only one of them justifies the hydrate:
// api()'s truncated 200 (client.ts:119-122), where the write landed and only the response was
// lost — the outbox refuses to replay it for exactly that reason, so a hydrate is the only thing
// that can recover the entry — and toApiError's catch-all for any unparseable error body at any
// status (client.ts:138), where the write did *not* land and the hydrate is a wasted full-history
// decrypt (the cost clock.ts:106-111 names). A 4xx gateway HTML page is the second kind. Hydrating
// on both is the cheap side of that trade: the first is unrecoverable without it, the second costs
// one request. Without this the revert below is a trap: the screen shows the opposite of the truth
// and every further tap gets the same 409.
const HYDRATE_CODES = new Set(['OPEN_ENTRY_EXISTS', 'NO_OPEN_ENTRY', 'UNKNOWN']);

// Overrides only where the server's own copy is not showable ("an open entry already exists") or
// where the plan specifies wording. Everything else falls through to e.message, which for this
// API is already user-facing English written for exactly this screen.
const COPY: Record<string, string> = {
  MOCKED_LOCATION: 'Mock location detected — disable fake GPS apps.',
  LOW_ACCURACY: 'GPS accuracy too low — step outside and retry.',
  STALE_TIMESTAMP: 'Device clock looks wrong — check date & time.',
  // No retry offered anywhere for this one: it is only reachable on a replayed clock-in and
  // there is nothing the worker can do to make it acceptable.
  QUEUED_TOO_OLD:
    'This shift waited too long to sync — ask your employer to add it manually.',
  OPEN_ENTRY_EXISTS: "You're already on shift — checking with the server.",
  NO_OPEN_ENTRY: "You're not on shift — checking with the server.",
  // Without this the fall-through shows client.ts's "The server returned a malformed response." —
  // developer copy, on the one path where the clock-in most likely *succeeded* and the hydrate is
  // about to put the worker on shift underneath it.
  UNKNOWN: "Couldn't read the server's reply — checking with the server.",
};

const now = () => new Date().toISOString();

function metres(details: Record<string, unknown> | undefined, key: string): number | null {
  const v = details?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// details is Record<string, unknown> straight off the wire, so a malformed payload must degrade
// to copy that still makes sense rather than interpolate "undefined" into someone's rejection.
function outOfRange(details: Record<string, unknown> | undefined, employer: string): string {
  const distance = metres(details, 'distance_m');
  // limit_m over the plan's literal "1 km": ANCHOR_RADIUS_M is one deployment-wide env var this
  // app hardcodes a stale copy of (fix.ts), and telling a worker to walk to 1 km when the server
  // enforces 150 m sends them somewhere that will be refused again. The refusal is the only place
  // the real limit ever travels.
  const limit = formatDistance(metres(details, 'limit_m') ?? DEFAULT_ANCHOR_RADIUS_M);
  return distance == null
    ? `You're too far from ${employer} — move within ${limit}.`
    : `You're ${formatDistance(distance)} from ${employer} — move within ${limit}.`;
}

/**
 * Maps a refusal to copy, and repairs the store when the refusal says our open/closed view is
 * wrong. The hydrate is deliberately not awaited: it is a 15 s request on a screen whose spinner
 * is still up, the mapped message is what the worker is owed right now, and hydrateFromServer()
 * rejects by design — so its rejection is caught here rather than left to replace the real error
 * with an unhandled one.
 */
function refused(e: unknown, employer: string): string {
  if (!(e instanceof ApiError)) return UNEXPECTED_ERROR;
  if (HYDRATE_CODES.has(e.code)) useClockStore.getState().hydrateFromServer().catch(() => {});
  if (e.code === 'OUT_OF_RANGE') return outOfRange(e.details, employer);
  return COPY[e.code] ?? e.message;
}

// A membership can be revoked while its shift is still running, so the id may resolve to nothing.
// Personal entries have no employer: the server anchors their clock-out on the clock-in location
// (entry/handler.go closeAnchor), which is what the copy has to name.
function employerName(memberships: Membership[], employerId: string | null): string {
  if (!employerId) return 'your shift location';
  return memberships.find((m) => m.employer.id === employerId)?.employer.name ?? 'your employer';
}

/** The optimistic entry: a lie, shaped so that nothing downstream can mistake it for a server
 * one. `id` is empty — 7.2 routes /entry/[id] and a fabricated id there would open a stranger's
 * shift, where a falsy one is a dead route. Nothing renders it today (6.1 reads clock_in.at and
 * employer_id; 7.1 lists server data), so falsy is enough to make a future mistake loud.
 * `location_verified` is false because the server has not run ValidateFix on this yet — that flag
 * is what an employer reads, and it is the one field here that must never be optimistic. */
function localEntry(clientId: string, employerId: string | null, fix: Fix): Entry {
  return {
    id: '',
    client_id: clientId,
    employer_id: employerId,
    status: 'open',
    clock_in: {
      at: fix.at,
      loc: {lat: fix.lat, lng: fix.lng},
      accuracy: fix.accuracy,
      mocked: fix.mocked,
    },
    clock_out: null,
    location_verified: false,
    flags: [],
    created_at: fix.at,
  };
}

/**
 * The dialog must never be the only thing that can settle this promise. prepare() awaits it while
 * the screen holds `inFlight` and `busy` (index.tsx:57-75), so a promise nothing resolves leaves
 * the clock button spinning for the life of the process, recoverable only by a reload — which is
 * the exact harm the confirm was added to prevent.
 *
 * That is what the AppState clause in canAlert() is for. Android's stash-and-replay for a dialog
 * raised while the host is paused does not work: showNewAlert parks the fragment on the
 * FragmentManagerHelper *instance* (DialogModule.kt:62-69), but `fragmentManagerHelper` is a getter
 * with no backing field that mints a fresh helper on every access (:158-172) — so onHostResume
 * (:109-118) calls showPendingAlert on a different object and returns at its null check (:37). The
 * fragment is never shown, so AlertFragment forwards neither onClick nor onDismiss
 * (AlertFragment.kt:47-53), actionCallback is never invoked and the promise never settles.
 * Reaching it is ordinary, not exotic: onHostPause is any screen-off or app-switch (:102-105), and
 * currentActivity is cleared only on destroy (ReactContext.java:328-330), so a merely-paused host
 * takes the stash branch rather than the "not attached to an Activity" error at :123. The window is
 * getFix()'s up-to-15 s, and this dialog only fires above MAX_ACCURACY_M — indoors or between tall
 * buildings, exactly where the read is slow and the phone goes into a pocket.
 *
 * AppState is the right reading because it is driven by the same LifecycleEventListener callbacks
 * that flip isInForeground: AppStateModule.kt:41-47 sets 'active'/'background' from
 * onHostResume/onHostPause, the two the dialog itself branches on.
 *
 * ponytail: two residuals survive, both milliseconds wide where the one removed was 15 s. A
 * configuration change can leave fragmentManager.isStateSaved true while AppState still reads
 * 'active' (:62), and a pause can land between this read and the native call. Ceiling: inside
 * either, the button is dead until relaunch. The upgrade path is not a timeout, which would
 * auto-answer "try anyway" for a worker who left the dialog up while walking outside for a better
 * fix; it is settling from the side that knows — an alert whose callback is guaranteed to fire
 * once. It is explicitly *not* this comment's earlier suggestion of resolving false on an AppState
 * change: on the far commoner path where the dialog did show, that settles a question still on
 * screen, and the worker's later tap on it would then do nothing.
 */
function confirmWeakGps(accuracy: number): Promise<boolean> {
  // Answering `true` where we cannot ask, not `false`: the server owns the accuracy verdict either
  // way (it refuses with LOW_ACCURACY, which COPY maps into readable copy), so proceeding costs at
  // worst one refusal the worker can act on, while defaulting to false would refuse a clock-in
  // over a question that was never actually put to them.
  if (!canAlert()) return Promise.resolve(true);

  return new Promise((resolve) => {
    Alert.alert(
      'GPS weak',
      `Your phone can only place you within ${formatDistance(accuracy)}. Clocking in may be refused.`,
      [
        {text: 'Cancel', style: 'cancel', onPress: () => resolve(false)},
        {text: 'Try anyway', onPress: () => resolve(true)},
      ],
      // onDismiss is load-bearing, but not for the reason it looks like: RN builds this config with
      // a literal `cancelable: false` and raises it only when the caller passes options.cancelable
      // (Alert.js:90, 93-94, applied at DialogModule.kt:63-64), which this call does not — so a
      // back press does *not* dismiss the dialog and does not need catching. It earns its place
      // because AlertFragmentListener is also the OnDismissListener (DialogModule.kt:73-74, 86-89):
      // ACTION_DISMISSED fires on any *other* teardown — a configuration change, the fragment being
      // destroyed — each of which would otherwise settle nothing. iOS never forwards it at all
      // (Alert.js:192 reads only userInterfaceStyle out of options), which is harmless there, since
      // an iOS alert has no dismissal that is not a button.
      {onDismiss: () => resolve(false)},
    );
  });
}

// `failed` present or `fix` present, never both — the optional-undefined pair is what lets the
// caller narrow with one `if` instead of repeating fourteen lines of reading and pre-checks.
type Prepared = {fix: Fix; failed?: undefined} | {fix?: undefined; failed: ClockResult};

async function prepare(): Promise<Prepared> {
  let fix: Fix;
  try {
    fix = await getFix();
  } catch (e) {
    // A LocationError is not an ApiError and must never be treated as one: its copy is already
    // user-safe, and there is no fix to queue — a retry needs a reading we do not have.
    return {
      failed: {done: false, message: e instanceof LocationError ? e.message : UNEXPECTED_ERROR},
    };
  }

  // No request at all: the server refuses a mocked fix before every other rule (entry/geo.go),
  // so queueing one would park a guaranteed rejection in the outbox and drop it on the next flush.
  if (fix.mocked) {
    Alert.alert('Mock location detected', 'Disable fake GPS apps, then try again.');
    // Where the dialog is a no-op the copy has to travel inline instead, or this is a tap that
    // does nothing and says nothing. ABORTED's null message is right only when the dialog spoke.
    return {failed: canAlert() ? ABORTED : {done: false, message: COPY.MOCKED_LOCATION}};
  }

  // Weak accuracy is a *prediction*, not a rule — the server owns the verdict, so "try anyway"
  // sends it and lets the refusal be authoritative.
  if (fix.accuracy > MAX_ACCURACY_M && !(await confirmWeakGps(fix.accuracy))) {
    return {failed: ABORTED};
  }

  return {fix};
}

/**
 * `employerId` null is a personal entry — the server reads an omitted `employer_id` that way, so
 * the key is left off rather than sent empty.
 */
export async function clockInNow(
  employerId: string | null,
  memberships: Membership[],
): Promise<ClockResult> {
  const p = await prepare();
  if (p.failed) return p.failed;

  // Once per *intent*, before the optimistic write, and reused by the body, the optimistic entry
  // and the outbox item alike. Never regenerated: this is the server's dedupe key, so a retry
  // that minted a fresh one would turn a request that landed but lost its response into a second
  // paid shift. The only retry path is the outbox replaying this exact item.
  const clientId = Crypto.randomUUID();

  const body: ClockInBody = {client_id: clientId, ...fixToBody(p.fix)};
  if (employerId) body.employer_id = employerId;

  // setPending, not setOpen: setOpen means "the server has ruled" and clears pendingSince, which
  // is the flag the "waiting for connection" pill reads. (The plan predates this store.)
  const local = localEntry(clientId, employerId, p.fix);
  useClockStore.getState().setPending(local);

  let entry: Entry;
  try {
    entry = await clockIn(body);
  } catch (e) {
    // The same classifier the outbox replays by, imported rather than restated: a live tap and
    // its own replay disagreeing about one status is a shift dropped or a shift duplicated.
    if (e instanceof ApiError && retryable(e.status)) {
      // Unchanged — `queued: true` is the flush's to add. Pre-marking here would flag a live tap
      // as backdated for the employer. The queue owns `body` from this line on.
      useOutboxStore
        .getState()
        .enqueue({kind: 'clock-in', clientId, body, queuedAt: now()});
      // The optimistic entry stands: the worker is on shift, the write is owed, not lost.
      onClockedIn(local);
      return OK;
    }
    useClockStore.getState().setOpen(null);
    return {done: false, message: refused(e, employerName(memberships, employerId))};
  }

  useClockStore.getState().setOpen(entry);
  onClockedIn(entry);
  return OK;
}

export async function clockOutNow(memberships: Membership[]): Promise<ClockResult> {
  // A cheap bail before spending up to 15 s on a fix. Unreachable from the button, which reads
  // "Clock in" whenever there is no open entry, so this only guards a programmatic caller.
  if (!useClockStore.getState().openEntry) return NOT_ON_SHIFT;

  const p = await prepare();
  if (p.failed) return p.failed;

  // Read *after* the await, not before it. This is the entry a refusal reverts to and the one the
  // queued close is keyed on, and prepare() spends up to 15 s in getFix() plus an open-ended
  // dialog — a hydrate (or a 9.1 flush) landing in that window replaces the running shift, and a
  // copy captured before it would overwrite the server's entry with a superseded one. For an
  // optimistic entry that means reverting to id '': a dead /entry/[id] route (7.2) carrying a
  // stale location_verified. Null now means the shift was closed elsewhere while we were reading
  // the GPS, which is exactly what it says.
  const open = useClockStore.getState().openEntry;
  if (!open) return NOT_ON_SHIFT;

  const clientId = Crypto.randomUUID();
  const body: ClockOutBody = {client_id: clientId, ...fixToBody(p.fix)};

  useClockStore.getState().setPending(null);

  let closed: Entry;
  try {
    closed = await clockOut(body);
  } catch (e) {
    if (e instanceof ApiError && retryable(e.status)) {
      useOutboxStore.getState().enqueue({
        kind: 'clock-out',
        clientId,
        // The *entry's* key, never this close's: the server stores a close under close_client_id
        // and never emits it, so 7.1 could otherwise not join a rejected clock-out to its row.
        // Correct whether `open` is a server entry or itself an unsent optimistic one — the
        // queued clock-in carries this same client_id.
        entryClientId: open.client_id,
        body,
        queuedAt: now(),
      });
      onClockedOut();
      return OK;
    }
    useClockStore.getState().setOpen(open);
    return {done: false, message: refused(e, employerName(memberships, open.employer_id))};
  }

  // setClosed, not setOpen(null): the clocked-out card reads `lastClosed`, so dropping the entry
  // the server just returned would leave the *previous* shift on screen until the next hydrate.
  // The offline path needs no equivalent — the outbox flush reconciles through
  // hydrateFromServer() (lib/sync.ts), which writes both fields.
  useClockStore.getState().setClosed(closed);
  onClockedOut();
  return OK;
}
