import type {Entry} from '@/api/entries';

/**
 * The claims the entry detail screen makes about one shift.
 *
 * A plain module rather than logic in the screen, for the reason lib/history.ts is one: every
 * sentence below is a statement about somebody's pay record — whether their location was checked,
 * whether their employer is seeing a flag — and each is wrong in a way that looks fine. There is no
 * renderer in this repo, so inside the component none of it is reachable.
 *
 * Type-only import, so this file runs under bare Node with its types stripped.
 */

export type BadgeTone = 'ok' | 'warn' | 'muted';

export type Badge = {
  tone: BadgeTone;
  /** Short verdict. Never the only carrier of the tone — the screen renders it as text. */
  label: string;
  /** Why the verdict says that. Always present: a badge nobody can explain is not evidence. */
  detail: string;
};

const NAMELESS = 'your employer';

/**
 * What `location_verified` is actually worth on this entry.
 *
 * The field is not a live measurement, and reading it as one is the mistake this function exists to
 * prevent. backend/internal/entry/store.go:173 writes `LocationVerified: true` on *every* clock-in,
 * personal or not, and nothing else ever writes it except Assign (store.go:117-131). So:
 *
 *   - employer entry, true  — a real claim: ValidateFix refused the clock-in outside the anchor and
 *     ValidateClose refused the clock-out, so the entry could not exist otherwise (geo.go:64).
 *   - personal entry, true  — vacuous. There was no anchor to be measured against: a personal fix
 *     is its own anchor (handler.go closeAnchor). Showing "Location verified" here would be a green
 *     tick for a check that never ran, and "Not verified" would accuse a worker of something the
 *     server never even looked for. Hence a third, neutral state.
 *   - false — reachable only through Assign, which re-measures *both* stored fixes against the
 *     employer's centre and records the answer without ever rejecting (handler.go:582-604, design
 *     §4.5 rule 5). Which is why the copy says "clock-in or clock-out": the server does not report
 *     which of the two missed, and naming clock-in alone (as the plan's example does) would be a
 *     guess printed as fact.
 */
export function locationBadge(entry: Entry, employerName: string | null): Badge {
  const name = employerName ?? NAMELESS;

  if (!entry.employer_id) {
    return {
      tone: 'muted',
      label: 'Location not checked',
      detail: 'A personal shift has no employer zone to check it against.',
    };
  }
  if (!entry.location_verified) {
    return {
      tone: 'warn',
      label: 'Location not verified',
      // No apology and no accusation: assigning never rejects hours, so the shift is on record
      // either way and the worker is owed that sentence more than the verdict.
      detail: `Clock-in or clock-out was outside ${name}'s zone. The shift is still recorded, and ${name} sees this.`,
    };
  }
  // `clock_out`, not `status`: the server never writes one on an open entry, and a shift still
  // running has had exactly one fix checked. Claiming both would be a promise about a clock-out
  // that has not happened.
  return {
    tone: 'ok',
    label: 'Location verified',
    detail: entry.clock_out
      ? `Clock-in and clock-out were both inside ${name}'s zone.`
      : `Clock-in was inside ${name}'s zone.`,
  };
}

export type FlagNote = {title: string; detail: string};

// Iterated in this order rather than in `flags` order, so two shifts with the same flags never
// present them differently.
//
// Neither of these is something the worker can act on, and neither is an accusation — one is a
// consequence of having no signal, the other is a reviewer's signal (model.go: "advisory only, the
// employer reviews it, the API never rejects it"). They are shown at all for one reason: the
// employer sees them (entry/handler.go employerView), and a worker walking into that conversation
// unaware is worse off than one who read it here first.
//
// ponytail: only the two flags the server emits today. A newer server's flag renders as nothing
// here while the employer still sees it. Ceiling: silence about one line of an employer's view.
// Upgrade path: add the entry to this map — deliberately not a raw-code fallback, which would put
// `speed_anomaly` in front of a worker as jargon.
const NOTES: [flag: string, note: FlagNote][] = [
  [
    'backdated',
    {
      title: 'Recorded offline',
      detail:
        'This shift was captured with no connection and reached the server later, so the hours were reported after the fact rather than measured live. Your employer sees this.',
    },
  ],
  [
    'speed_anomaly',
    {
      title: 'Unusual movement',
      detail:
        'Location updates during this shift moved further, faster than expected. Your employer may ask about it. Your hours are unaffected.',
    },
  ],
];

export function flagNotes(flags: string[]): FlagNote[] {
  return NOTES.filter(([flag]) => flags.includes(flag)).map(([, note]) => note);
}

// Assign's own refusals, by code. Deliberately *not* an extension of lib/clockFlow.ts's COPY map,
// which shares not one key with this route: that map answers MOCKED_LOCATION / LOW_ACCURACY /
// STALE_TIMESTAMP / QUEUED_TOO_OLD / OPEN_ENTRY_EXISTS / NO_OPEN_ENTRY — verdicts on a *fix being
// captured now* — while PATCH /v1/entries/:id sends a fix nowhere and can only answer about the
// entry's state. Merging them would mean one map where two thirds of the keys are unreachable from
// either caller, and clockFlow's version also arms a clock-store hydrate on the way past, which is
// exactly wrong here. `metres()` is likewise not borrowed: assign returns no distance details,
// because it never rejects on distance.
//
// Only codes whose server text is not showable are listed; everything else falls through to
// `message`, which for this API is user-facing English (client.ts's offline and session copy
// included). Keep it that way — mapping NETWORK here would replace a good sentence with a worse one.
const ASSIGN_COPY: Record<string, string> = {
  // Both INVALID_ARGUMENT causes on this route say the same thing to a worker: the entry is not in
  // the state this request assumed — already assigned, or not closed (handler.go:553-561). The UI
  // only offers the button when neither holds, so arriving here means the view is stale, and the
  // answer to all of it is the same: look again.
  INVALID_ARGUMENT: 'This shift can no longer be assigned. Pull down to refresh it.',
  NOT_FOUND: 'This shift no longer exists.',
  RATE_LIMITED: 'Too many requests just now. Wait a moment and try again.',
  // The assign most likely *landed* — UNKNOWN is api()'s truncated-200 as well as its unparseable
  // body (client.ts:119-122, 138) — so the fall-through's "The server returned a malformed
  // response." would be developer copy on top of a wrong implication.
  UNKNOWN: "Couldn't read the server's reply. Pull down to refresh and check whether it worked.",
};

export function assignError(code: string, message: string, employerName: string): string {
  // Named, because /v1/me can be minutes stale and "not a member" of *which* employer is the whole
  // content of the answer.
  if (code === 'NOT_MEMBER') return `You're no longer a member of ${employerName}.`;
  return ASSIGN_COPY[code] ?? message;
}

/**
 * The entry this screen is about, out of the window it fetched.
 *
 * The open entry is a second source because it has to be: lib/history.ts merges an open entry that
 * is *older* than the fetched window into the list, so a row can exist whose entry no 30-day fetch
 * will ever return.
 *
 * The empty-id guard is load-bearing rather than defensive. An unsent optimistic entry has
 * `id: ''` (clockFlow.localEntry), so without it a route reached with no id would match that entry
 * and render a shift the server has never seen as though it were on record.
 */
export function findEntry(entries: Entry[], openEntry: Entry | null, id: string): Entry | null {
  if (!id) return null;
  return entries.find((e) => e.id === id) ?? (openEntry?.id === id ? openEntry : null);
}
