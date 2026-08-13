import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';

import {ApiError} from '@/api/client';
import {
  type ClockInBody,
  type ClockOutBody,
  clockIn,
  clockOut,
  MAX_PING_BATCH,
  type Ping,
  postPings,
} from '@/api/entries';

type Queued = {
  /** The server's idempotency key for this write, and this item's identity in the queue. */
  clientId: string;
  /** When the item was queued. Not sent and not used by the flush — the server judges age from
   * `body.at`, the capture time, which is the payroll record. Kept for 7.1's banner copy. */
  queuedAt: string;
};

export type OutboxItem =
  | (Queued & {kind: 'clock-in'; body: ClockInBody})
  // entryClientId beyond the plan's shape, and load-bearing: the server stores a close under
  // `close_client_id` and never emits it, so the Entry rows 7.1 renders are keyed by the
  // *clock-in* id. Matching a rejected clock-out by its own clientId would find no row and
  // silently never light the warning icon — the case a worker most needs to see.
  | (Queued & {kind: 'clock-out'; entryClientId: string; body: ClockOutBody})
  | (Queued & {kind: 'pings'; body: Ping[]});

export type Attention = {
  kind: OutboxItem['kind'];
  clientId: string;
  /** The `client_id` of the entry row 7.1 should mark; null for pings, which have no row. */
  entryClientId: string | null;
  code: string;
  message: string;
};

type OutboxState = {
  items: OutboxItem[];
  needsAttention: Attention[];
  /**
   * Queue a write that could not be sent. 6.4's contract: try the request live first and enqueue
   * only when the failure is retryable, passing the body it just tried **unchanged** — the flush
   * adds `queued`, so a body pre-marked here would flag a live tap as backdated.
   */
  enqueue(item: OutboxItem): void;
  flush(): Promise<void>;
  /** 7.1's banner owns this: the records are permanent otherwise, and nothing else can know the
   * user has read them. Clears all — one dismiss, not per-row bookkeeping. */
  clearAttention(): void;
};

// Retrying costs a duplicate request the server dedupes; dropping costs a worker their hours, so
// this is a total function over `status` rather than a 4xx/5xx if-chain with a hole in it.
//   0   NETWORK, the offline case (api() maps every transport failure to it).
//   429 RATE_LIMITED. Every route here is limited per sub per path at 30/min and a FIFO flush
//       after an offline shift bursts straight past that — permanent would drop real data.
//   >=500 the server's problem, not the payload's.
// Everything else drops, and that "else" is why the rule is written this way: api() can throw
// ApiError(200, 'UNKNOWN') on a truncated body — the write landed, so a retry would double the
// clock-in — and ApiError(400, 'CONFIG') for a build with no EXPO_PUBLIC_API_URL, which is inlined
// at build time and can never start working, so retrying it parks the queue forever.
function retryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

// ponytail: a flat cap, no per-code grouping. Ceiling: a build stuck on CONFIG drops every item
// with the same message and the oldest records fall off the end (the queue is already drained by
// then, so nothing further is lost). Upgrade path: dedupe by code when 7.1 has real copy for them.
const MAX_ATTENTION = 50;

// One flush at a time. A second caller joins the in-flight promise rather than returning
// immediately, because `await flush()` has to mean "the queue has been worked": 9.1 follows it
// with hydrateFromServer(), and a no-op resolve would hydrate against a server that has not seen
// the queue yet. Cleared in a finally, so a throw cannot wedge the queue shut.
let inFlight: Promise<void> | null = null;

// Resolved from onRehydrateStorage below. persist's own onFinishHydration is not usable here: it
// is skipped entirely when the storage read rejects (zustand middleware.mjs — the catch path only
// calls postRehydrationCallback), so awaiting it would park the queue forever on a corrupt store.
let markHydrated = () => {};
const hydrated = new Promise<void>((resolve) => {
  markHydrated = resolve;
});

// The server rejects a batch over MAX_PING_BATCH whole, with a 400 — non-retryable, so an
// oversized item would be *dropped*. Split at enqueue rather than at send: every queued item is
// then independently sendable, and each chunk carries its own key, so a partially-flushed batch
// leaves no ambiguity about which half is still owed.
function chunk(item: OutboxItem): OutboxItem[] {
  if (item.kind !== 'pings' || item.body.length <= MAX_PING_BATCH) return [item];
  const out: OutboxItem[] = [];
  for (let i = 0; i < item.body.length; i += MAX_PING_BATCH) {
    out.push({
      ...item,
      clientId: `${item.clientId}-${i / MAX_PING_BATCH}`,
      body: item.body.slice(i, i + MAX_PING_BATCH),
    });
  }
  return out;
}

function send(item: OutboxItem): Promise<unknown> {
  switch (item.kind) {
    // queued: true is what makes a replay legal at all — without it anything more than
    // MAX_CLOCK_SKEW late is rejected STALE_TIMESTAMP, which is a 4xx, which is a drop.
    // The close needs it as much as the clock-in: its past bound is lifted only when queued.
    case 'clock-in':
      return clockIn({...item.body, queued: true});
    case 'clock-out':
      return clockOut({...item.body, queued: true});
    // ponytail: pings carry no idempotency key on the wire, so a batch the server accepted but
    // never acknowledged is re-sent as duplicate breadcrumbs. Tolerated: they are decoration, not
    // hours, and SpeedAnomaly already ignores non-positive intervals (geo.go) so duplicates raise
    // no flag. Upgrade path: a batch client_id, or a unique index on {entry_id, at}.
    case 'pings':
      return postPings(item.body);
  }
}

function attentionFor(item: OutboxItem, e: ApiError): Attention {
  return {
    kind: item.kind,
    clientId: item.clientId,
    entryClientId:
      item.kind === 'clock-out' ? item.entryClientId : item.kind === 'clock-in' ? item.clientId : null,
    code: e.code,
    message: e.message,
  };
}

function uniqueByClientId<T extends {clientId: string}>(xs: T[]): T[] {
  return [...new Map(xs.map((x) => [x.clientId, x])).values()];
}

/**
 * The offline queue. Everything a clock tap could not send lives here until it can be, so the
 * only way an item leaves is a server answer: accepted, or refused on grounds a retry cannot fix.
 *
 * Deliberately knows nothing about the clock store. 9.1 owns the flush triggers and follows a
 * flush with hydrateFromServer(), which is the authoritative reconcile for both outcomes —
 * an accepted replay comes back as the open entry, a dropped one as no entry (the revert). Calling
 * setOpen() per item from here would duplicate that one moment early and reintroduce exactly the
 * pill flicker clock.ts's second ponytail note describes. **This hands 9.1 one obligation**:
 * hydrateFromServer() does not touch `pendingSince`, so 9.1 must clear it after a drain (setOpen
 * with the hydrated entry) or the "waiting for connection" pill sticks forever.
 */
export const useOutboxStore = create<OutboxState>()(
  persist(
    (set, get) => {
      async function drain(): Promise<void> {
        // items is empty until rehydration lands, and a drain that ran first would report an empty
        // queue as a successful flush. Resolves on the storage *error* path too — see markHydrated.
        await hydrated;

        for (;;) {
          const item = get().items[0];
          if (!item) return;

          try {
            await send(item);
          } catch (e) {
            // api() guarantees only ApiError, so this is a bug in our own code, not a verdict on
            // the item: rethrow with the item still queued rather than classify what we cannot
            // read. The finally on flush() releases the guard, so the next trigger retries.
            if (!(e instanceof ApiError)) throw e;
            // Stops where it stands rather than trying the next item: order is a correctness rule,
            // and a clock-out that overtakes its own clock-in finds no open entry, comes back 4xx,
            // and is dropped — a whole shift lost to a queue that was only out of signal.
            if (retryable(e.status)) return;
            set((s) => ({
              items: s.items.filter((i) => i.clientId !== item.clientId),
              needsAttention: [...s.needsAttention, attentionFor(item, e)].slice(-MAX_ATTENTION),
            }));
            continue;
          }
          // Removed by key against fresh state, not by index into the snapshot above: an enqueue
          // (or a rehydrate) can land during the await, and a stale `slice(1)` would drop it.
          set((s) => ({items: s.items.filter((i) => i.clientId !== item.clientId)}));
        }
      }

      return {
        items: [],
        needsAttention: [],

        enqueue: (item) => set((s) => ({items: [...s.items, ...chunk(item)]})),

        clearAttention: () => set({needsAttention: []}),

        flush: () =>
          (inFlight ??= drain().finally(() => {
            inFlight = null;
          })),
      };
    },
    {
      name: 'clockit-outbox',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({items, needsAttention}) => ({items, needsAttention}),
      // The default merge lets the stored state *replace* what is in memory (persist calls
      // set(state, true)), which here would silently eat a clock-in tapped during the rehydration
      // window — the launch-in-a-dead-zone case. Concatenated instead, stored first so FIFO age
      // order survives, deduped because a write racing the read could leave the same item in both.
      merge: (persisted, current) => {
        const stored = persisted as Partial<OutboxState> | undefined;
        return {
          ...current,
          items: uniqueByClientId([...(stored?.items ?? []), ...current.items]),
          needsAttention: uniqueByClientId([
            ...(stored?.needsAttention ?? []),
            ...current.needsAttention,
          ]),
        };
      },
      // Unconditional, and the only thing that releases the flush: persist calls this callback on
      // a read *error* as well as on success (ui.test.js pins that), and a corrupt store must
      // leave the queue working on an empty list rather than never flushing again.
      onRehydrateStorage: () => () => {
        // persist writes storage on every set *except* the merge itself, so an item recovered by
        // the concat above would sit in memory only — and an enqueue during the rehydration window
        // has by then already overwritten storage with the pre-merge list. One write puts the
        // union back on disk. (Costs one redundant write per launch, as ui.ts's does.)
        useOutboxStore.setState({});
        markHydrated();
      },
    },
  ),
);
