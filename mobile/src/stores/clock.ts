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

type ClockState = {
  /** The running shift — server-confirmed, or optimistic while `pendingSince` is set. */
  openEntry: Entry | null;
  /**
   * When the still-unacknowledged optimistic write was made (task 6.4), else null. Set only by
   * setPending, cleared only by setOpen — so "optimistic" is one flag, not a convention every
   * caller has to remember. Task 6.1 renders the "waiting for connection" pill from it.
   */
  pendingSince: string | null;
  /** The server has ruled: accepted (`e` = the returned entry) or rejected (revert). Clears
   * `pendingSince`, which is what re-arms hydrateFromServer — see there. */
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
 * calls setOpen(). The queued clock-in is not lost, only invisible for that window (7.1's "N
 * actions waiting to sync" banner still shows, since it reads the outbox). Upgrade path: wrap this
 * store in `persist` over {openEntry, pendingSince} the way ui.ts does.
 */
export const useClockStore = create<ClockState>((set, get) => ({
  openEntry: null,
  pendingSince: null,

  setOpen: (openEntry) => set({openEntry, pendingSince: null}),
  setPending: (openEntry) => set({openEntry, pendingSince: new Date().toISOString()}),

  // Unbounded window, deliberately not the plan's "today". Nothing ever ages an open entry out —
  // `time_entries` has no TTL and no sweeper, and a clock-out has no past bound at all, so a shift
  // someone forgot to close last month is still open and still closable at its own timestamp
  // (design §4.5). A `from = start of today` query filters on clock_in.at, so it would miss that
  // entry — and an ordinary 23:30 overnight shift too. The screen would then say "clocked out"
  // while every tap 409s OPEN_ENTRY_EXISTS, whose handler (6.4) is this very function: a loop with
  // no way out. Being right costs one unpaginated response.
  //
  // ponytail: that response is the user's whole history — a few hundred documents for a year of
  // shifts, per the backend store's own note. Upgrade path: a `status=open` filter or a limit on
  // GET /v1/entries, then pass it here. Not a narrower date window, which reintroduces the miss.
  //
  // Failure policy — the load-bearing decision in this file. It rejects like session.loadMe()
  // rather than swallowing, and never clears state on the way out; callers hold their own error
  // state. Two ways that matters, both of them "do not tell a worker on shift that they are
  // clocked out while their clock-in sits in the outbox":
  //   1. `set` runs only after a resolved request, so an offline hydrate leaves `openEntry` alone.
  //   2. The pending check is *after* the await, not before it: an offline tap can land mid-flight,
  //      and from that moment the server's answer is known-stale — the outbox holds a write the
  //      server has not seen. The outbox owns the reconcile (9.1): it calls setOpen() when the item
  //      is accepted or dropped, clearing `pendingSince` and re-arming this.
  hydrateFromServer: async () => {
    const entries = await listEntries();
    if (get().pendingSince !== null) return;
    set({openEntry: newestOpen(entries)});
  },
}));
