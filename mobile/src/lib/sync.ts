import NetInfo from '@react-native-community/netinfo';
import {AppState} from 'react-native';

import {useClockStore} from '@/stores/clock';
import {hydrated, useOutboxStore} from '@/stores/outbox';

/**
 * When the outbox drains, and what has to happen afterwards.
 *
 * A plain module rather than an effect in app/_layout.tsx, for lib/clockFlow.ts's reason: the
 * decisions below — which events count as a reconnect, when the reconcile is worth its cost,
 * when the "waiting for connection" pill may be cleared — are only reachable with a NetInfo
 * event stream, a queue that drains halfway and a server that answers, and inside a component
 * none of them can be driven at all (this repo has no renderer). The gate keeps what only the
 * gate has: whether there is a signed-in user to sync for.
 *
 * Not in stores/outbox.ts, which the plan names: that store "deliberately knows nothing about
 * the clock store" (its docblock) and the reconcile below is precisely a clock-store call, so
 * putting this there would make the queue depend on what it is careful not to know — and would
 * pull NetInfo, a native module, into the one file every clock test already imports.
 */

// Pings are excluded on purpose: they are decoration, not hours (stores/outbox.ts), so a batch
// leaving the queue changes nothing about open/closed and must not buy a full-history decrypt.
const clockItems = (): number =>
  useOutboxStore.getState().items.filter((i) => i.kind !== 'pings').length;

// One sync at a time, joining rather than dropping — the same shape, and for a related reason, as
// the flush guard it wraps. flush() already collapses two triggers into one request, but each
// caller still gets its own resolution and would each run the reconcile below: NetInfo->true and
// AppState->active both fire when a phone is unlocked in a dead zone, and hydrateFromServer() is
// the app's most expensive call (clock.ts: the user's whole history, decrypted server-side).
let running: Promise<void> | null = null;

async function run(): Promise<void> {
  // The same gate flush() waits on (stores/outbox.ts), awaited here too because the depth
  // comparison below is only meaningful against a queue that has been read off disk. At launch an
  // unrehydrated store reports 0 before *and* after a replay that really happened, so `after >=
  // before` skips the reconcile — and nothing else covers it: the clock store has no optimistic
  // entry to revert at launch, but it still owes the *server's* post-replay answer, and
  // app/(tabs)/index.tsx's mount hydrate is not ordered after the replay, and the replay bumps no
  // write generation of its own, so its pre-replay answer stands. A relaunch with a queued
  // clock-in then reads "Clocked out" until the next tap 409s its way through clockFlow.ts's
  // HYDRATE_CODES.
  await hydrated;

  const before = clockItems();

  // Captured with it, and so behind the gate rather than in front of it: a tap landing inside the
  // rehydration window is now part of `pendingBefore` and gets its pill cleared, where a capture
  // ahead of the await would have read null and stranded it at the `pendingBefore != null` check
  // below. Captured at all for the same reason `after` is read again below: a live tap landing
  // during the flush writes its own `pendingSince`, and the pill cleared at the end of this function
  // would then be that tap's — a clock-out tapped while the last queued clock-in drains reads "on
  // shift, nothing pending" with a close still owed, the exact lie the `after === 0` guard exists
  // to prevent, arriving concurrently instead. Same shape as clock.ts's write ticket: capture,
  // then act only if it is unchanged.
  const pendingBefore = useClockStore.getState().pendingSince;

  // Swallowed, and the counts below are why it costs nothing to: flush() rejects only on a
  // non-ApiError escaping the request layer — a bug in our own code — and it leaves the item
  // queued when it does, so the next trigger retries. There is no screen here to show it to, and
  // a rejection thrown on from a NetInfo callback is an unhandled rejection and nothing else.
  await useOutboxStore
    .getState()
    .flush()
    .catch(() => {});

  const after = clockItems();
  // "Any flush that contained clock items", read off the queue rather than from a return value:
  // flush() promises Promise<void> and its join semantics are pinned by a test that compares the
  // two promises for identity, so widening it to report what it drained would mean either a new
  // shape for every caller or a second, weaker contract beside the tested one. Depth before and
  // after says the same thing from outside, and says it for the drop case too — an item that was
  // refused permanently also leaves, and its optimistic entry is exactly what needs reverting.
  // A live tap enqueuing while one item drains can net to `after === before` and skip the
  // reconcile: harmless, because something is still queued, so the pill is honest and the next
  // trigger flushes what is left.
  if (after >= before) return;

  // The authoritative reconcile for both outcomes: an accepted replay comes back as the open
  // entry, a dropped one as no entry. Rejection is expected, not exceptional — an offline hydrate
  // is a dead zone, and clock.ts never clears state on the way out, so the screen keeps what it
  // had. Awaited, and its outcome recorded, so the pill below is cleared against the server's
  // answer rather than in front of it: a drain that succeeds followed by a GET /v1/entries that
  // fails (the app's heaviest route, fired one second after signal returned) has no answer to
  // clear it against, and on the drop path the optimistic entry is still standing.
  //
  // No signed-in guard, and the sign-out race is why it needs none: lib/signOut.ts clears the
  // credentials *before* it empties the queue, so a sync still in flight across a sign-out finds
  // no token and this request never leaves the device — and reset() has bumped the write
  // generation by then, so even a request that somehow answered could not put the previous
  // worker's shift back on screen. Two independent stops; a third would only cost an import.
  let reconciled = false;
  await useClockStore
    .getState()
    .hydrateFromServer()
    .then(() => {
      reconciled = true;
    })
    .catch(() => {});

  // The obligation stores/outbox.ts hands this file: hydrateFromServer() never touches
  // pendingSince, so without this the "waiting for connection" pill (6.1) survives the sync that
  // made it false, for the life of the process.
  //
  // `after === 0` is clock.ts's own upgrade path (b), "call setOpen only after the last clock
  // item in a flush": a shift worked in a dead zone queues a clock-in *and* a clock-out, and
  // clearing the flag when the clock-in alone was accepted would read "on shift, timer running,
  // nothing pending" while the close is still owed. Guarded on the flag being set because setOpen
  // bumps the write generation, which would void a hydrate someone else has in flight for nothing.
  //
  // ponytail: `reconciled` leaves a residual — a failed hydrate leaves the pill up until the next
  // clock action, because a later trigger finds an empty queue, returns at the depth check above
  // and never reaches this line. That is the honest residual (the connection did just fail, and
  // the drop path's optimistic entry is still on screen) but it is a new ceiling: "waiting for
  // connection" outlives the wait. Upgrade path is clock.ts's other option (a) — key the pill off
  // outbox depth, which 7.1 already renders from, so it is a computed value with no flag to strand.
  // Deliberately not closed by reconciling whenever `pendingSince != null && after === 0`: that
  // fires inside a live tap's own optimistic window, and a setOpen(null) from a server view
  // predating the tap would take the worker off shift mid-request.
  const clock = useClockStore.getState();
  if (reconciled && after === 0 && pendingBefore != null && clock.pendingSince === pendingBefore) {
    clock.setOpen(clock.openEntry);
  }
}

function syncNow(): void {
  void (running ??= run().finally(() => {
    running = null;
  }));
}

/**
 * Arms the triggers and flushes once, on every arming. Call while signed in, and call the returned
 * function when that stops being true: a NetInfo or AppState listener that outlives a sign-out
 * flushes a device-wide queue against whoever signs in next (stores/outbox.ts is not user-scoped).
 *
 * The flush is per *arming*, not per process, because a second arming inside one process is a real
 * session that can own real queued hours: an unrecoverable 401 ends a session while deliberately
 * *keeping* the queue (app/_layout.tsx clears credentials and the clock store only; a 401 is
 * retryable, stores/outbox.ts), so the worker signing back in arrives owning unsent shifts with
 * nothing else to move them — NetInfo's subscribe-time event is swallowed below as a non-transition
 * and AppState only emits on a real change, so their hours would sit until some incidental event
 * while the server's MAX_QUEUED_AGE ran down. Repeated and concurrent calls (a StrictMode double
 * mount) cost one flush: they collapse on the `running` join above.
 *
 * ponytail: tearing the listeners down is not the same as scoping the queue, and the difference is
 * the ceiling lib/signOut.ts hands this file by name. Worker A is 401'd out, the queue survives by
 * design, worker B signs in on the same phone, `signedIn` goes true, and the first trigger here
 * replays A's clock-in under B's Auth0 token: someone else's hours, silently, undoable only by an
 * employer edit. The hazard predates these triggers (stores/outbox.ts's docblock argues it in full)
 * but this is what fires it. Upgrade path is that file's per-sub scoping — `persist.setOptions({name:
 * `clockit-outbox-${sub}`})` plus `.rehydrate()` on every sign-in, with its `hydrated` gate made
 * re-armable — and it cannot be closed from here: a guard on this side would only park the queue.
 */
export function startSync(): () => void {
  syncNow();

  // undefined until the first event, and that third state is what stops "is true" reading as
  // "became true": NetInfo hands a new subscriber the current state (State.add), so without it
  // every arming would issue a second sync. *When* that arrives differs by arming, and the first
  // one in a process is the case this guard is load-bearing for: `add` calls the handler
  // synchronously only if `_latestState` is already populated, and index.ts constructs State
  // lazily on the first addEventListener with a constructor whose `_fetchCurrentState()` is async
  // — so at first arming `_latestState` is null and the `latest().then(handler)` branch is taken.
  // That event lands a native round trip later, by which time the flush above may have settled and
  // there is no `running` to join. Nothing catches it there but this comparison. What keeps the
  // *launch* cheap even so is the depth check in run(), not the join: a flush that settled that
  // fast found an empty queue, so a twin would drain nothing and return before the reconcile.
  // Second and later armings do hit the synchronous branch and genuinely do collapse on the join.
  // The plan says *transition* either way.
  //
  // `isConnected`, not `isInternetReachable`, which is deliberately weaker: reachability is a HEAD
  // to clients3.google.com, so it is null while in flight, stays false behind any captive portal
  // or firewalled network our own API is reachable through, and lags a real reconnect by a request
  // (internetReachability.ts). The flush is its own reachability test — a send that fails is
  // retryable and stays queued — so the cheap, early, occasionally-wrong signal is the right one.
  // Repeats are not filtered by the library either (only the reachability half dedupes), and a
  // phone hopping cell towers emits plenty, hence the comparison rather than a plain `if`.
  let connected: boolean | null | undefined;
  const stopNetInfo = NetInfo.addEventListener((state) => {
    const previous = connected;
    connected = state.isConnected;
    if (previous !== undefined && previous !== true && state.isConnected === true) syncNow();
  });

  // A second AppState listener, not the one on app/(tabs)/index.tsx: that one lives in a
  // useFocusEffect, so it is unmounted whenever the worker is on History or Profile — and it was
  // widened to `!== "background"` for the distance poller, which would fire this on every glance
  // at a notification centre. AppState is an event emitter and takes both.
  //
  // `active` fires on every unlock and every return from a dialog, so this is the noisiest
  // trigger: the guard against that is not here but downstream — a flush with an empty queue is a
  // resolved promise and no request, and the reconcile only runs when something actually left.
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') syncNow();
  });

  return () => {
    stopNetInfo();
    appState.remove();
  };
}
