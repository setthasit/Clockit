import {api} from '@/api/client';
import type {Fix, LatLng} from '@/api/types';

/** A clock event as the server records it. Note `accuracy`/`mocked` sit beside `loc`,
 * unlike the request body where `accuracy` is inside it. */
export type ClockPoint = {
  at: string;
  loc: LatLng;
  accuracy: number;
  mocked: boolean;
};

export type Entry = {
  id: string;
  client_id: string;
  employer_id: string | null;
  status: 'open' | 'closed';
  clock_in: ClockPoint;
  clock_out: ClockPoint | null;
  location_verified: boolean;
  // Never null (the server normalises to []). Left as string[] rather than a union:
  // nothing validates this at runtime, so a newer server's flag would make a union lie.
  // Today the only emitted value is 'speed_anomaly'.
  flags: string[];
  created_at: string;
};

type ClockBody = {
  at: string;
  loc: LatLng & {accuracy: number};
  mocked: boolean;
  /** Set only by an outbox replay (task 5.2), never by a live tap. It widens the *past*
   * staleness bound to MAX_QUEUED_AGE (72 h, then `QUEUED_TOO_OLD` 422) — mock, accuracy,
   * anchor and the future bound all still apply — and an accepted event older than
   * MAX_CLOCK_SKEW gets a `backdated` flag the employer sees, which is why a live tap must
   * leave it off. See backend/internal/entry/geo.go ValidateFix. */
  queued?: boolean;
};

export type ClockInBody = ClockBody & {
  client_id: string;
  /** Omitted or empty ⇒ personal entry. */
  employer_id?: string;
};

export type ClockOutBody = ClockBody & {
  client_id: string;
  // The server parses the same struct here but ignores employer_id (the open entry
  // already knows its employer); `never` makes that impossible to pass by mistake.
  employer_id?: never;
};

/** Reshapes a Fix into the request body's nesting: accuracy inside loc, mocked beside it.
 * Spread it into a clock call: `clockIn({client_id, employer_id, ...fixToBody(fix)})`. */
export function fixToBody(fix: Fix): ClockBody {
  return {
    at: fix.at,
    loc: {lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy},
    mocked: fix.mocked,
  };
}

// 201 on a new entry, 200 when client_id replays — indistinguishable here on purpose,
// a replay is a success for the outbox either way.
export async function clockIn(body: ClockInBody): Promise<Entry> {
  const {entry} = await api<{entry: Entry}>('/v1/entries/clock-in', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return entry;
}

export async function clockOut(body: ClockOutBody): Promise<Entry> {
  const {entry} = await api<{entry: Entry}>('/v1/entries/clock-out', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return entry;
}

/** Both bounds optional and inclusive of everything when omitted. Dates, not strings, so
 * a caller cannot hand the server a non-RFC3339 value: toISOString() is always RFC3339 UTC. */
export async function listEntries(from?: Date, to?: Date): Promise<Entry[]> {
  const params: string[] = [];
  if (from) params.push(`from=${encodeURIComponent(from.toISOString())}`);
  if (to) params.push(`to=${encodeURIComponent(to.toISOString())}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  // ponytail: hand-built query string — RN's URLSearchParams polyfill is partial and this
  // is two optional params. Switch if a route ever needs real param handling.
  const {entries} = await api<{entries: Entry[]}>(`/v1/entries${query}`);
  return entries;
}

/** Attaches an employer to a personal entry after the fact. Server rejects unless the entry
 * is closed and has no employer yet. */
export async function assignEmployer(id: string, employerId: string): Promise<Entry> {
  const {entry} = await api<{entry: Entry}>(`/v1/entries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({employer_id: employerId}),
  });
  return entry;
}

export type Ping = {
  at: string;
  // accuracy is accepted and dropped server-side for pings; optional so a breadcrumb
  // built from a coarse fix does not have to invent one.
  loc: LatLng & {accuracy?: number};
};

/** Server rule, not a client one: a batch over MAX_PING_BATCH is rejected whole. The outbox
 * (task 5.2) owns chunking — this function sends exactly what it is given. */
export const MAX_PING_BATCH = 64;

/** Resolves with the number stored; 0 when there is no open shift to attach to. */
export async function postPings(pings: Ping[]): Promise<number> {
  const {accepted} = await api<{accepted: number}>('/v1/pings', {
    method: 'POST',
    body: JSON.stringify({pings}),
  });
  return accepted;
}
