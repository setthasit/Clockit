import * as Crypto from 'expo-crypto';
import {Alert} from 'react-native';

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
// verdicts (httpx/codes.go); UNKNOWN is api()'s truncated-200, where the write landed and only
// the response was lost — the outbox refuses to replay it for exactly that reason, so a hydrate
// is the only thing that can recover the entry. Without this the revert below is a trap: the
// screen shows the opposite of the truth and every further tap gets the same 409.
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

// onDismiss is load-bearing, not polish: Android alerts are cancelable by default, so a back
// press or an outside tap fires no button handler at all — without it this promise never settles
// and the button stays spinning for the life of the process.
function confirmWeakGps(accuracy: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'GPS weak',
      `Your phone can only place you within ${formatDistance(accuracy)}. Clocking in may be refused.`,
      [
        {text: 'Cancel', style: 'cancel', onPress: () => resolve(false)},
        {text: 'Try anyway', onPress: () => resolve(true)},
      ],
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
    return {failed: ABORTED};
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
  // Captured before the optimistic write, because it is also what a refusal reverts to: there is
  // no new entry here, only a running shift that must survive a rejected close.
  const open = useClockStore.getState().openEntry;
  if (!open) return {done: false, message: "You're not on shift."};

  const p = await prepare();
  if (p.failed) return p.failed;

  const clientId = Crypto.randomUUID();
  const body: ClockOutBody = {client_id: clientId, ...fixToBody(p.fix)};

  useClockStore.getState().setPending(null);

  try {
    await clockOut(body);
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

  useClockStore.getState().setOpen(null);
  onClockedOut();
  return OK;
}
