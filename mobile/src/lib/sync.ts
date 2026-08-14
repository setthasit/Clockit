import NetInfo from '@react-native-community/netinfo';
import {AppState} from 'react-native';

import {useClockStore} from '@/stores/clock';
import {useOutboxStore} from '@/stores/outbox';

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
  // Read ahead of the outbox's rehydration gate (stores/outbox.ts: `await hydrated`, whose own
  // comment warns that a drain running before it reports an empty queue as a successful flush), so
  // a launch flush can compare against a queue that has not been read off disk yet and skip the
  // reconcile. Deliberate, and safe only because of where it can happen: the launch flush is the
  // only trigger that can precede rehydration, and at launch there is nothing to reconcile — the
  // clock store is not persisted, so it is empty, and app/(tabs)/index.tsx hydrates on its own
  // mount regardless. Awaiting the gate from here would mean exporting it, for a case with no
  // symptom.
  const before = clockItems();

  // Captured with it, for the same reason `after` is read again below: a live tap landing during
  // the flush writes its own `pendingSince`, and the pill cleared at the end of this function
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

// Once per process, not once per start. The launch flush is "successful launch after loadMe()"
// (plan §9.1), and the gate's `me` is what says loadMe() succeeded — but `me` is also cleared
// mid-session by onUnauthorized(), and the gate answers that by loading it again. Tying a flush
// to every arrival of `me` would therefore close a loop through a 401: flush 401s -> me cleared ->
// me reloaded -> flush 401s, forever, against an endpoint that is refusing us. The queue survives
// a 401 by design (stores/outbox.ts), so the next AppState or NetInfo trigger replays it anyway;
// this only stops the session's own recovery from being one of them. Never reset: a second
// sign-in inside one process starts from an empty queue (clearForSignOut) and the clock tab
// hydrates on its own mount, so there is nothing for a second launch flush to do.
let launchFlushed = false;

/**
 * Arms the triggers. Call while signed in, and call the returned function when that stops being
 * true: a NetInfo or AppState listener that outlives a sign-out flushes a device-wide queue
 * against whoever signs in next (stores/outbox.ts is not user-scoped).
 */
export function startSync(): () => void {
  if (!launchFlushed) {
    launchFlushed = true;
    syncNow();
  }

  // undefined until the first event, which is a third state and a load-bearing one: NetInfo
  // delivers the current state to a new subscriber immediately (State.add -> handler(latest)),
  // so a listener that treated "is true" as "became true" would fire a second sync alongside the
  // launch one above — two full-history decrypts for one launch. The plan says *transition*.
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
