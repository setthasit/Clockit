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
  /** The `client_id` of the entry row 7.1 should mark; null for pings, which have no row. It may
   * name a row that will never exist: a dropped clock-in leaves its own clock-out to be sent
   * next, answered NoOpenEntry (409, non-retryable) and dropped in turn. 7.1 must render an
   * unmatched record on its own rather than skip anything it cannot join to an entry. */
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
   * adds `queued`, so a body pre-marked here would flag a live tap as backdated. The queue then
   * **owns that body**: `chunk` stores a non-ping item by reference, so mutating it after this
   * call rewrites what gets replayed, and the next write puts the mutation on disk.
   *
   * ponytail: void, so the AsyncStorage write this triggers is neither awaited nor caught. Ceiling:
   * a failed write (disk full, SQLite error, Android per-DB limit) leaves the item in memory only,
   * and the next kill loses it with no record anywhere — wider than the rehydration window, which
   * needs a kill within milliseconds, where this needs only a kill any time after the failure.
   * Upgrade path: type it `Promise<void>` and return `set(...) as Promise<void>` — at runtime
   * persist's wrapped set returns the storage write's promise, and inside this initializer zustand
   * declares that set's return as `unknown` (persist.d.ts, `Pr = unknown`), so one cast reaches it.
   * `unknown` is exactly the reason this stays a comment: zustand declares a return value and
   * declares it unknowable, i.e. promises nothing about what it is. So the cast has to be pinned by
   * a test the day it is written, once 6.4 has a reason to await durability — untested, it would
   * resolve on nothing the day that value changes, which is worse than the gap.
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
//   401 UNAUTHENTICATED — a verdict on the *session*, not on the item, which is why it belongs
//       with NETWORK rather than with the 4xx drops. client.ts raises it two ways: getToken
//       rejecting non-retryably (session.ts: NO_REFRESH_TOKEN / SESSION_EXPIRED / RENEW_FAILED /
//       any unrecognised code — precisely the long-offline case this queue exists for), and the
//       server refusing the token. Both are recoverable by signing back in as the same Auth0 sub,
//       after which every queued client_id and its original `at` are still acceptable inside
//       MAX_QUEUED_AGE. Dropping would destroy the *whole* queue in one pass — the head drops,
//       `continue` hands the next item the identical 401 — which is the exact harm session.ts
//       maps raw iOS Auth0 codes to avoid. The cost is bounded per trigger, not per item:
//       onUnauthorized() has already routed the user to sign-in and the `return` below spends one
//       401, not N. It is not bounded in *time*, and only the clock-in ages out — ValidateFix
//       drops one past MaxQueuedAge as QUEUED_TOO_OLD (422), while ValidateClose widens that
//       ceiling to MaxInt64 and pingFixes checks shape only (entry/geo.go, entry/handler.go), so a
//       parked close or ping batch waits indefinitely. That is the server's deliberate choice
//       rather than rot: "refusing a late close can only strand the shift open", so a close that
//       waits out a dead session still ends in acceptance, which is the outcome we want here.
//   429 RATE_LIMITED. Every route here is limited per sub per path at 30/min and a FIFO flush
//       after an offline shift bursts straight past that — permanent would drop real data.
//   >=500 the server's problem, not the payload's.
// Everything else drops, and that "else" is why the rule is written this way: api() can throw
// ApiError(200, 'UNKNOWN') on a truncated body — the write landed, so a retry would double the
// clock-in — and ApiError(400, 'CONFIG') for a build with no EXPO_PUBLIC_API_URL, which is inlined
// at build time and can never start working, so retrying it parks the queue forever.
// Exported for task 6.4's live tap, which must classify a failure identically to the replay of
// that same item: the two disagreeing over one status is either a dropped shift or a duplicated
// one. Shared rather than restated, for that reason alone.
export function retryable(status: number): boolean {
  return status === 0 || status === 401 || status === 429 || status >= 500;
}

// A flat cap, evicting the *newest*, with no per-code grouping. Direction is the point: an
// Attention record is the only surviving trace of a dropped item, and the only cascade that can
// overflow 50 (a build stuck on CONFIG drops every queued item with one identical message) makes
// the records near-duplicates — so evicting the newest throws away copies, while evicting the
// oldest would throw away the earliest failures, which are the oldest and most likely real hours.
// ponytail: the cap stays rather than going away, because this list is persisted and only 7.1's
// dismiss ever clears it, and a long offline shift queues ping chunks by the dozen. Ceiling: past
// 50 the newest evidence is lost. Upgrade path: dedupe by code when 7.1 has real copy for them.
const MAX_ATTENTION = 50;

// One flush at a time. A second caller joins the in-flight promise rather than returning
// immediately, because `await flush()` has to mean "the queue has been worked": 9.1 follows it
// with hydrateFromServer(), and a no-op resolve would hydrate against a server that has not seen
// the queue yet. Cleared in a finally, so a throw cannot wedge the queue shut.
let inFlight: Promise<void> | null = null;

// Resolved from onRehydrateStorage below. persist's own onFinishHydration is not usable here: it
// is skipped entirely when the storage read rejects (zustand middleware.mjs — the catch path only
// calls postRehydrationCallback), so awaiting it would park the queue forever on a corrupt store.
//
// Exported for lib/sync.ts, which measures queue depth either side of a flush and would otherwise
// read 0 before *and* after a launch replay, skipping the reconcile that replay is owed. Same gate,
// awaited twice, not a second one.
let markHydrated = () => {};
export const hydrated = new Promise<void>((resolve) => {
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
    // ponytail: pings carry neither an idempotency key nor an entry reference on the wire, so a
    // batch the server accepted but never acknowledged is re-sent as duplicate breadcrumbs — and a
    // batch flushed after the shift it was captured on has closed lands on whatever entry is open
    // at request time (handler.go looks up OpenEntry then), i.e. on the *next* shift's track. FIFO
    // keeps that rare; a live clock-out with pings still queued reaches it. Both are tolerated:
    // breadcrumbs are decoration, not hours, and neither can raise a false flag, because
    // SpeedAnomaly ignores non-positive intervals (geo.go) — which covers duplicates, and covers
    // the misfiled batch too, since its fixes are older than the new shift's clock-in it is
    // measured against. The cost is a polluted track. Upgrade path: a batch client_id and an
    // entry_id on the wire, or a unique index on {entry_id, at}.
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
 * pill flicker clock.ts's second ponytail note describes. **This hands 9.1 two obligations**:
 * hydrateFromServer() does not touch `pendingSince`, so 9.1 must clear it after a drain (setOpen
 * with the hydrated entry) or the "waiting for connection" pill sticks forever. And 9.1 must not
 * trigger a flush on session-state change: onUnauthorized() calls session.clear(), which writes a
 * fresh object on *every* 401 — harmless once per trigger, but a 401 here would then re-trigger
 * the flush that produced it, and the queue survives 401s by design, so it would not settle.
 *
 * **And it hands 8.1 one, which is a correctness rule, not polish**: the queue is stored under a
 * single device-wide key and is therefore NOT scoped to a user, so items outlive a sign-out.
 * Sign out must call `clearForSignOut()` below — call it, do not open-code it: the order and the
 * hydration gate are both easy to get wrong, in ways that fail silently (see its own comment).
 *
 * Skip it and the next person to sign in on a shared phone — the shift-work case this app is for —
 * flushes the previous worker's queued clock-in against their own Auth0 sub on the first trigger:
 * someone else's hours land on their account, silently, and only an employer edit can undo it.
 * Note this queue deliberately survives a 401 (see `retryable`), so the window is a real one and
 * not a race: the items are still there, waiting, when the next user arrives.
 *
 * **That clear destroys unsent hours, so 8.1 owes the worker a choice before it**: a non-empty
 * `items` is captured shifts no server has seen. 8.1 must `await flush()` first, or warn ("N
 * unsynced actions will be lost", plan §8.1) and let the worker cancel. Clearing unconditionally
 * loses a queued shift silently — the same harm this file survives a dead session to prevent,
 * arriving through a different door.
 *
 * ponytail: one global storage key, and an obligation delegated rather than enforced. Ceiling: a
 * sign-out path that never calls clearForSignOut() reintroduces the leak, and nothing here can
 * fail loudly when it does. Upgrade path: per-sub scoping, which cannot be done at module scope
 * because no `sub` exists yet — the session store would have to call
 * `useOutboxStore.persist.setOptions({name: `clockit-outbox-${sub}`})` then `.rehydrate()` on every
 * sign-in, which also needs this file's `hydrated` promise to become re-armable.
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
            // and is dropped — a whole shift lost to a queue that was only out of signal. The drop
            // path below does reach that outcome by design (see Attention.entryClientId); keeping
            // it off the *retryable* path is what stops a signal problem from causing it.
            if (retryable(e.status)) return;
            set((s) => ({
              items: s.items.filter((i) => i.clientId !== item.clientId),
              needsAttention: [...s.needsAttention, attentionFor(item, e)].slice(0, MAX_ATTENTION),
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
      // Declared now, with a passthrough migrate, rather than left to default. persist throws a
      // stored blob away when its version differs and no migrate is given — it logs and hands
      // `merge` undefined — and the re-persist below would then write the resulting empty queue
      // straight over it. So without these two lines the *next* person to bump this number
      // silently destroys every queued shift on every phone, once, with nothing to roll back to.
      // Passing the payload through costs nothing today and hands the old blob to `merge` instead
      // of undefined. It is not itself a migration: a bump that really changes the shape still
      // reaches `merge`, which keeps only what it can read, and persist then writes that result
      // back over the blob — so whoever bumps this number still owes a real migrate. This only
      // stops the *default* path from wiping every phone by omission.
      //
      // Partial, not OutboxState: the stored blob is partialize's output and carries no actions.
      // `merge` re-narrows it anyway, so the cast asserts nothing it trusts.
      version: 0,
      migrate: (persisted) => persisted as Partial<OutboxState>,
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
      // persist calls this callback on a read *error* as well as on success (ui.test.js pins that).
      // markHydrated() is therefore deliberately outside the guard and must stay there: on a normal
      // launch this is the only thing that releases the flush (clearForSignOut is the sole other
      // caller), so gating it would leave a phone whose storage failed to read once unable to send
      // anything, ever.
      onRehydrateStorage: () => (_state, error) => {
        // persist writes storage on every set *except* the merge itself, so an item recovered by
        // the concat above would sit in memory only — and an enqueue during the rehydration window
        // has by then already overwritten storage with the pre-merge list. One write puts the
        // union back on disk. (Costs one redundant write per launch, as ui.ts's does.)
        //
        // Not written when the read failed: state is then just the defaults, and persisting them
        // would overwrite a blob that is only unreadable *now* — a transient AsyncStorage error is
        // survivable, and next launch may well parse it. The guard cannot cover the version-
        // mismatch case, which persist reports as success with `error` undefined; that is what the
        // migrate above is for.
        if (!error) useOutboxStore.setState({});
        markHydrated();
      },
    },
  ),
);

/**
 * 8.1's sign-out must call this. It is three lines and every one of them is load-bearing in an
 * order that is not obvious, which is why it lives here and not in the screen:
 *
 *  - setState first, clearStorage second. persist writes storage on every set, so clearing the
 *    key first would leave the setState's write behind and the queue back on disk.
 *  - setState is not enough on its own. The launch rehydrate's `merge` concatenates *stored*
 *    items in front of memory, so leaving the blob there lets it resurrect the previous worker's
 *    clock-in and send it under the new user's sub — the exact leak this exists to close.
 *  - markHydrated last, and it is the reason a screen cannot open-code this. clearStorage() bumps
 *    persist's internal hydrationVersion, and every `.then` in its in-flight hydrate bails on that
 *    mismatch — *including* the one that calls onRehydrateStorage. Sign out during the launch read
 *    (onUnauthorized -> a 401 at launch routes straight here) and markHydrated is never called, so
 *    `await hydrated` never resolves, so the promise `inFlight` caches never settles: every flush
 *    for the rest of the process is dead, silently, with items piling up on disk and no error
 *    anywhere. Resolving an already-resolved promise is a no-op, so calling it here is free
 *    otherwise.
 *
 * Note this does not sign out of anything, and it destroys unsent hours — see the store's docblock
 * for what 8.1 owes the worker before calling it.
 */
export function clearForSignOut(): void {
  useOutboxStore.setState({items: [], needsAttention: []});
  useOutboxStore.persist.clearStorage();
  markHydrated();
}
