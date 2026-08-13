import {create} from 'zustand';

import {type Entry, listEntries} from '@/api/entries';

// The server's unique partial index on {user_id} where status:"open"
// (backend/internal/mongox/indexes.go) makes a second open entry impossible, so this only has a
// choice to make against a broken or future server. Newest wins rather than "whichever the array
// yielded first": that is the shift the worker is actually on, and the elapsed timer the clock
// screen derives from it would otherwise count from a stranded month-old entry. Compared as
// instants, not strings — Go marshals RFC3339 with trailing zeros trimmed, so "10:00:00Z" sorts
// *after* "10:00:00.5Z" lexicographically.
function newestOpen(entries: Entry[]): Entry | null {
  return entries.reduce<Entry | null>(
    (best, e) =>
      e.status === 'open' && (!best || Date.parse(e.clock_in.at) > Date.parse(best.clock_in.at))
        ? e
        : best,
    null,
  );
}

// Bumped by every write to openEntry, local or remote. A hydrate takes a ticket before its request
// and drops its answer if the ticket is stale — see hydrateFromServer.
let writeGen = 0;

type ClockState = {
  /** The running shift — server-confirmed, or optimistic while `pendingSince` is set. */
  openEntry: Entry | null;
  /** When the still-unacknowledged optimistic write was made (task 6.4), else null. Purely the
   * "waiting for connection" pill's flag (task 6.1) — it guards nothing. */
  pendingSince: string | null;
  /** The server has ruled: accepted (`e` = the returned entry) or rejected (revert). */
  setOpen(e: Entry | null): void;
  /** Optimistic, not yet accepted: a local entry for a clock-in, null for a clock-out. */
  setPending(e: Entry | null): void;
  hydrateFromServer(): Promise<void>;
};

/**
 * Am I on shift. No elapsed/tick state on purpose: the clock screen derives it from
 * `openEntry.clock_in.at` on its own 1 s interval, so a store field would re-render every
 * subscriber once a second to say something they can each compute.
 *
 * Not persisted: `openEntry` is server-authoritative and refetched below at launch, so a stored
 * copy would only be a second thing to invalidate. The queued *write* is what must survive a kill,
 * and the task 5.2 outbox persists that itself.
 *
 * ponytail: the ceiling of not persisting is a kill while `pendingSince` is set — the flag is lost,
 * and if the launch hydrate is offline the screen says "clocked out" until the outbox flushes and
 * calls setOpen(entry). The queued clock-in is not lost, only invisible for that window (7.1's "N
 * actions waiting to sync" banner still shows, since it reads the outbox). Upgrade path: wrap this
 * store in `persist` over {openEntry, pendingSince} the way ui.ts does.
 *
 * ponytail: `pendingSince` is one global flag for what is really a per-item queue property, so a
 * whole shift worked in a dead zone under-reports. The outbox then holds a clock-in *and* a
 * clock-out; the flush accepts the clock-in, calls setOpen(entry), and the pill vanishes for the
 * width of the next request while the clock-out is still queued — "on shift, timer running, nothing
 * pending", which is a lie. Correctness is unaffected (writeGen, not this flag, is what protects
 * state). Upgrade path belongs to 9.1: the pill's real source of truth is outbox depth, which 7.1
 * already renders from `outbox.items.length`, so either key the pill off that or call setOpen only
 * after the last clock item in a flush.
 */
export const useClockStore = create<ClockState>((set) => ({
  openEntry: null,
  pendingSince: null,

  setOpen: (openEntry) => {
    writeGen++;
    set({openEntry, pendingSince: null});
  },
  setPending: (openEntry) => {
    writeGen++;
    set({openEntry, pendingSince: new Date().toISOString()});
  },

  // Unbounded window, deliberately not the plan's "today". Nothing ever ages an open entry out —
  // `time_entries` has no TTL and no sweeper, and a clock-out has no past bound at all, so a shift
  // someone forgot to close last month is still open and still closable at its own timestamp
  // (design §4.5). A `from = start of today` query filters on clock_in.at, so it would miss that
  // entry — and an ordinary 23:30 overnight shift too. The screen would then say "clocked out"
  // while every tap 409s OPEN_ENTRY_EXISTS, whose handler (6.4) is this very function: a loop with
  // no way out. There is no cheaper correct route today: Store.OpenEntry (store.go:135-137) is
  // exactly this query, but RegisterRoutes (handler.go:43-54) exposes no GET /v1/entries/open.
  //
  // ponytail: the price is the user's whole history, decrypted, on every hydrate. List's loop
  // (handler.go:431-438) runs h.view -> h.point -> store.openLoc per point, and each of those is an
  // UnwrapDEK plus an AES-GCM open — 2 per closed entry, so ~1500 decrypts and ~250 KB of plaintext
  // coordinates for a three-year user, none of which this store reads. Scheduled upgrade, not
  // aspirational: add `status=open` (or a limit) to GET /v1/entries and pass it here. Not a
  // narrower date window, which reintroduces the miss above.
  //
  // Failure policy — the load-bearing decision in this file. It rejects like session.loadMe()
  // rather than swallowing, and never clears state on the way out; callers hold their own error
  // state. Three ways that matters, all of them "do not tell a worker on shift that they are
  // clocked out":
  //   1. `set` runs only after a resolved request, so an offline hydrate leaves `openEntry` alone.
  //   2. The staleness check is *after* the await, not before it: a write can land mid-flight, and
  //      from that moment the server's answer describes a world without it. That covers an
  //      optimistic tap (setPending) and equally an outbox flush the server has already accepted
  //      (setOpen) — which is why the ticket is a write counter rather than `pendingSince`, a flag
  //      setOpen clears precisely when the guard is needed.
  //   3. Concurrent hydrates are ordinary — NetInfo->true and AppState->active both fire when a
  //      phone is unlocked in a dead zone — so the newer one's ticket voids the older one's answer:
  //      last *issued* wins, not last *responded*.
  hydrateFromServer: async () => {
    const mine = ++writeGen;
    const entries = await listEntries();
    if (mine !== writeGen) return;
    set({openEntry: newestOpen(entries)});
  },
}));
