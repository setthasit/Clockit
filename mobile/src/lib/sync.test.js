// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts modules under test.
//
// The triggers are the last thing between a queued clock-in and the server, and every branch below
// needs something no hand can stage: a NetInfo stream that repeats itself, a queue that drains
// halfway, a foreground and a reconnect landing in the same tick. The real stores/outbox.ts,
// stores/clock.ts and lib/sync.ts are driven; only the two native event sources, AsyncStorage and
// the endpoint functions are stubbed.
//
// Each test imports its own copy of sync.ts (`?tag`), because `running` and the NetInfo tri-state
// are module scope: a leftover one would swallow or join the next test's trigger. The stores it
// imports resolve to the same URLs, so they stay singletons — which is the point: it is the real
// queue being drained each time. `outboxTag` below is the one deliberate exception.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const NETINFO_STUB = 'stub:netinfo';
const RN_STUB = 'stub:react-native';
const ASYNC_STORAGE_STUB = 'stub:async-storage';
const ENTRIES_STUB = 'stub:api-entries';

// `@/stores/outbox` resolves to the singleton like every other `@/` import — the queue being
// drained is the real one, shared with the clock store. Set this and the *next* module to import it
// gets a fresh copy instead, which is the only way to reach the rehydration window from here: the
// singleton's `hydrated` resolved once at module load, and reset() writes items through setState,
// which bypasses persist entirely. Same harness stores/outbox.test.js uses (`./outbox.ts?window`).
let outboxTag = '';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@react-native-community/netinfo') {
      return {url: NETINFO_STUB, shortCircuit: true};
    }
    if (specifier === 'react-native') return {url: RN_STUB, shortCircuit: true};
    if (specifier === '@react-native-async-storage/async-storage') {
      return {url: ASYNC_STORAGE_STUB, shortCircuit: true};
    }
    if (specifier === '@/api/entries') return {url: ENTRIES_STUB, shortCircuit: true};
    if (specifier === '@/stores/outbox' && outboxTag) {
      return {url: new URL(`stores/outbox.ts?${outboxTag}`, src).href, shortCircuit: true};
    }
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    // Modelled on the shipped State class, and the one behaviour that matters is the one a naive
    // stub would smooth over: `add` hands a brand-new subscriber the latest state with nothing
    // having transitioned. It has *two* branches for that and they differ in timing, so both are
    // modelled here — `handler(this._latestState)` synchronously when a state object already
    // exists, else `this.latest().then(handler)`, a native round trip later (state.ts `add`).
    // `deferSubscribe` stages that second branch, which is the one a launch takes: index.ts builds
    // State lazily on the first addEventListener and its constructor's `_fetchCurrentState()` is
    // async, so `_latestState` is still null at that first `add`. Repeats are not filtered on
    // either branch — `_handleNativeStateUpdate` forwards every native event — hence `emit` with
    // no equality check.
    if (url === NETINFO_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const handlers = new Set();
          let latest = {isConnected: true, isInternetReachable: true};
          let pending = null;
          export function setLatest(s) { latest = s; }
          export function emitNet(s) { latest = s; for (const h of [...handlers]) h(s); }
          export function netHandlerCount() { return handlers.size; }
          // Delivery is what is held, not subscription: the real async branch still adds the
          // handler to the set first, and resolves with the state as of the round trip's return.
          export function deferSubscribe() {
            pending = [];
            return () => { const held = pending; pending = null; for (const h of held) h(latest); };
          }
          export default {
            addEventListener(handler) {
              handlers.add(handler);
              if (pending) pending.push(handler); else handler(latest);
              return () => handlers.delete(handler);
            },
          };
        `,
      };
    }
    if (url === RN_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const handlers = new Set();
          export function emitAppState(s) { for (const h of [...handlers]) h(s); }
          export function appHandlerCount() { return handlers.size; }
          export const AppState = {
            addEventListener(type, handler) {
              handlers.add(handler);
              return {remove: () => handlers.delete(handler)};
            },
          };
        `,
      };
    }
    if (url === ASYNC_STORAGE_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const items = new Map();
          let gate = null;
          // Holds the storage read open so a launch flush can be armed *inside* the rehydration
          // window. Snapshot at call time then stall, as stores/outbox.test.js does: AsyncStorage
          // runs on a serial queue, so a read issued first sees what a later write has not
          // replaced. Only its resolution is delayed.
          export function blockReads() {
            let release;
            gate = new Promise((r) => (release = r));
            return () => { gate = null; release(); };
          }
          export default {
            getItem: async (k) => {
              const v = items.get(k) ?? null;
              if (gate) await gate;
              return v;
            },
            setItem: async (k, v) => { items.set(k, v); },
            removeItem: async (k) => { items.delete(k); },
          };
        `,
      };
    }
    // listEntries is stubbed alongside the writes because the reconcile's *cost* is the reason it
    // is conditional at all (clock.ts: the user's whole history, decrypted server-side), so this
    // file has to be able to count it.
    if (url === ENTRIES_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const MAX_PING_BATCH = 64;
          export const calls = [];
          export const lists = [];
          let responder = async () => ({});
          let entries = [];
          let listError = null;
          let onList = () => {};
          export function setResponder(fn) { responder = fn; }
          export function setEntries(e) { entries = e; }
          // The reconcile can fail on its own after a drain that succeeded — it is the app's
          // heaviest route on a 15 s timeout, fired from a phone that has had signal for one
          // second — and onList is what lets a live tap land *inside* that window.
          export function setListError(e) { listError = e; }
          export function setOnList(fn) { onList = fn; }
          export function resetCalls() { calls.length = 0; lists.length = 0; }
          export function clockIn(body) { calls.push(['clock-in', body]); return responder('clock-in', body); }
          export function clockOut(body) { calls.push(['clock-out', body]); return responder('clock-out', body); }
          export function postPings(pings) { calls.push(['pings', pings]); return responder('pings', pings); }
          export async function listEntries() {
            lists.push(Date.now());
            onList();
            if (listError) throw listError;
            return entries;
          }
        `,
      };
    }
    return next(url, context);
  },
});

const {deferSubscribe, emitNet, netHandlerCount, setLatest} = await import(NETINFO_STUB);
const {appHandlerCount, emitAppState} = await import(RN_STUB);
const storage = await import(ASYNC_STORAGE_STUB);
const {calls, lists, resetCalls, setEntries, setListError, setOnList, setResponder} =
  await import(ENTRIES_STUB);
const {ApiError} = await import('@/api/client');
const {useClockStore} = await import('@/stores/clock');
const {useOutboxStore} = await import('@/stores/outbox');

const AT = '2026-02-13T09:00:00Z';
const KEY = 'clockit-outbox';

// Enough turns for persist's rehydrate chain, a drain of three items and the reconcile behind it.
// Real timers, so a hang fails an assertion instead of hanging the suite.
const settle = async () => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
};

const clockBody = (id) => ({
  client_id: id,
  at: AT,
  loc: {lat: 49.28, lng: -123.12, accuracy: 8},
  mocked: false,
});

const inItem = (id) => ({kind: 'clock-in', clientId: id, queuedAt: AT, body: clockBody(id)});
const outItem = (id, entryClientId) => ({
  kind: 'clock-out',
  clientId: id,
  entryClientId,
  queuedAt: AT,
  body: clockBody(id),
});
const pingItem = (id) => ({
  kind: 'pings',
  clientId: id,
  queuedAt: AT,
  body: [{at: AT, loc: {lat: 49.28, lng: -123.12}}],
});

const entry = (id, closed) => ({
  id,
  client_id: id,
  employer_id: null,
  status: closed ? 'closed' : 'open',
  clock_in: {at: AT, loc: {lat: 49.28, lng: -123.12}, accuracy: 8, mocked: false},
  clock_out: closed ? {at: AT, loc: {lat: 49.28, lng: -123.12}, accuracy: 8, mocked: false} : null,
  location_verified: true,
  flags: [],
  created_at: AT,
});

const outbox = () => useOutboxStore.getState();
const clock = () => useClockStore.getState();

// No test below queues more than three items or expects more than two reconciles, so a fourth send
// means the drain is going round again and a third list means a trigger is re-firing itself.
// Asserted *inside* the stubs rather than after the fact: a defect that loops leaves the flush
// promise unsettled, and the suite would then hang until the runner kills it and report a
// cancellation, which is not a failure and is easy to miss.
const MAX_SENDS = 4;

const ceiling = () => {
  assert.ok(calls.length <= MAX_SENDS, 'the drain re-sent an item it should have removed');
  assert.ok(lists.length <= 2, 'the reconcile re-fired itself');
};

const succeed = () =>
  setResponder(async () => {
    ceiling();
    return {};
  });

let tag = 0;
const freshSync = () => import(new URL(`./sync.ts?${++tag}`, import.meta.url).href);

function reset(items = []) {
  resetCalls();
  succeed();
  setEntries([]);
  setListError(null);
  setOnList(() => {});
  setLatest({isConnected: true, isInternetReachable: true});
  useOutboxStore.setState({items, needsAttention: []});
  clock().reset();
}

const sends = () => calls.length;

test('every arming flushes, not just the first one in the process', async () => {
  // "Successful launch after loadMe()" — and a second arming inside one process is a second real
  // session, because a 401 ends one while deliberately *keeping* the queue (app/_layout.tsx clears
  // credentials and the clock store only; 401 is retryable, stores/outbox.ts). So the worker who
  // signs back in owns unsent hours, and nothing else here would move them: the subscribe event is
  // swallowed as a non-transition and AppState only emits on a real change. They would sit until
  // some incidental event while the server's MAX_QUEUED_AGE ran down.
  reset([inItem('c-1')]);

  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['c-1'],
    'the launch never flushed the queue it was signed in with',
  );
  assert.deepEqual(outbox().items, []);

  stop();
  outbox().enqueue(inItem('c-2'));
  const stopAgain = startSync();
  await settle();

  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['c-1', 'c-2'],
    'a re-arm left the queue the 401 exit preserved sitting unsent',
  );
  assert.deepEqual(outbox().items, []);
  stopAgain();
});

test('a transition to connected flushes; a repeat does not', async () => {
  // The plan says *transition* to true, and NetInfo forwards every native event without deduping,
  // so a phone hopping cell towers repeats "connected" all day. This is the guard's `previous !==
  // true` half; its `previous !== undefined` half is the test below.
  reset();
  const {startSync} = await freshSync();
  // Armed on an empty queue, so the flush that arming issues costs nothing and the clock-in below
  // is exposed to the events alone.
  const stop = startSync();
  await settle();

  outbox().enqueue(inItem('c-1'));
  emitNet({isConnected: true, isInternetReachable: true});
  await settle();
  assert.equal(sends(), 0, 'a repeat "still connected" event flushed');

  emitNet({isConnected: false, isInternetReachable: false});
  emitNet({isConnected: true, isInternetReachable: true});
  await settle();
  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['c-1'],
    'a real reconnect did not flush',
  );

  stop();
});

test('the subscribe event is not a transition, even landing after the arming flush', async () => {
  // The other half of the guard, staged on the branch a launch actually takes: NetInfo builds its
  // State lazily on the first addEventListener and fetches the current state asynchronously, so
  // the first arming in a process is handed `isConnected: true` a native round trip later — after
  // startSync's own flush has settled, with no `running` left to join. A clock-in queued in that
  // gap is then exposed to the subscribe event alone, and treating it as a transition sends it
  // (and buys a full-history decrypt) on the strength of a connection that never changed.
  reset([inItem('c-1')]);
  const deliver = deferSubscribe();
  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();
  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['c-1'],
    'the arming flush never drained the queue it was armed with',
  );

  outbox().enqueue(inItem('c-2'));
  deliver();
  await settle();

  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['c-1'],
    'the subscribe event was treated as a transition to connected',
  );
  assert.equal(lists.length, 1, 'the subscribe event bought a second full-history decrypt');

  stop();
});

test('AppState active flushes; background and inactive do not', async () => {
  // `inactive` is a pulled-down notification centre or an incoming call banner — the app never
  // left, so nothing has changed about the queue.
  reset();
  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  outbox().enqueue(inItem('c-1'));
  emitAppState('background');
  emitAppState('inactive');
  await settle();
  assert.equal(sends(), 0, 'a background or inactive transition flushed');

  emitAppState('active');
  await settle();
  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['c-1'],
  );

  stop();
});

test('only a flush that drained clock items reconciles', async () => {
  // hydrateFromServer() is the app's most expensive call — the whole history, decrypted per
  // entry, on a route with no rate limiter — so an empty flush and a ping batch must not buy one.
  // Pings are decoration, not hours: nothing about open/closed changes when a batch lands.
  reset();
  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  emitAppState('active');
  await settle();
  assert.equal(lists.length, 0, 'a flush that drained nothing hydrated');

  outbox().enqueue(pingItem('p-1'));
  emitAppState('active');
  await settle();
  assert.equal(sends(), 1, 'the ping batch was not sent');
  assert.equal(lists.length, 0, 'a drained ping batch bought a full-history decrypt');

  outbox().enqueue(inItem('c-1'));
  emitAppState('active');
  await settle();
  assert.equal(lists.length, 1, 'an accepted clock-in was never reconciled against the server');

  stop();
});

test('a dropped clock item reconciles too', async () => {
  // The revert path: a permanently refused clock-in leaves the queue exactly as an accepted one
  // does, and the optimistic entry standing behind it is precisely what has to come off the
  // screen. Reading depth before and after says both without the queue reporting verdicts.
  reset([inItem('c-1')]);
  clock().setPending(entry('', false));
  setResponder(async () => {
    ceiling();
    throw new ApiError(422, 'QUEUED_TOO_OLD', 'too late');
  });

  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  assert.equal(lists.length, 1, 'a dropped shift left an optimistic entry on screen unreconciled');
  assert.equal(outbox().needsAttention.length, 1);
  assert.equal(clock().openEntry, null, 'the reverted entry survived the reconcile');
  assert.equal(clock().pendingSince, null);

  stop();
});

test('the pill clears once the last clock item is gone, and not one request before', async () => {
  // A whole shift worked in a dead zone: the queue holds a clock-in *and* its close. Clearing
  // pendingSince when the clock-in alone is accepted reads "on shift, timer running, nothing
  // pending" while the close is still owed — clock.ts's named ceiling, closed here by its own
  // upgrade path (b): setOpen only after the last clock item.
  reset([inItem('c-1'), outItem('close-1', 'c-1')]);
  clock().setPending(entry('', false));
  setEntries([entry('server-1', false)]);
  setResponder(async (kind) => {
    ceiling();
    if (kind === 'clock-out') throw new ApiError(500, 'INTERNAL', 'boom');
    return {};
  });

  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  assert.deepEqual(
    outbox().items.map((i) => i.clientId),
    ['close-1'],
    'the drain did not stop on the retryable close',
  );
  assert.equal(lists.length, 1, 'the accepted clock-in was not reconciled');
  assert.equal(clock().openEntry?.id, 'server-1');
  assert.notEqual(
    clock().pendingSince,
    null,
    'the "waiting for connection" pill went out while a clock-out was still queued',
  );

  // The close lands on the next trigger; now the queue is empty and the pill is a lie.
  succeed();
  setEntries([entry('server-1', true)]);
  emitAppState('active');
  await settle();

  assert.deepEqual(outbox().items, []);
  assert.equal(
    clock().pendingSince,
    null,
    'hydrateFromServer never touches pendingSince — the pill sticks for the life of the process',
  );
  assert.equal(clock().openEntry, null, 'the closed shift was left running');

  stop();
});

test('a reconcile that failed does not clear the pill', async () => {
  // The drain succeeds and then GET /v1/entries does not — the app's heaviest route (the whole
  // history, ~2 decrypts per entry) on a 15 s timeout, fired from a phone that has had signal for
  // one second. There is no server answer to clear the pill against, and on the drop path
  // clock.ts keeps the optimistic entry, so clearing anyway reads "on shift, timer running,
  // nothing pending" for a shift the server may have permanently refused.
  reset([inItem('c-1')]);
  clock().setPending(entry('', false));
  setListError(new ApiError(0, 'NETWORK', 'offline'));

  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  assert.deepEqual(outbox().items, [], 'the clock-in was not drained');
  assert.equal(lists.length, 1);
  assert.notEqual(
    clock().pendingSince,
    null,
    'the pill was cleared in front of the server rather than against its answer',
  );
  assert.notEqual(clock().openEntry, null, 'a failed hydrate cleared the optimistic entry');

  // The residual the ponytail note names: the queue is empty now, so the next trigger returns at
  // the depth check and never reconciles — the pill stays up until the next clock action.
  setListError(null);
  emitAppState('active');
  await settle();
  assert.equal(lists.length, 1, 'an empty queue bought a full-history decrypt');
  assert.notEqual(clock().pendingSince, null);

  stop();
});

test('a clock action taken during the reconcile keeps its own pill', async () => {
  // A clock-out tapped while the last queued clock-in drains. The hydrate can still return the
  // shift as open (the close has not been sent yet), and clearing pendingSince then clears one
  // belonging to a *newer* optimistic write: "on shift, nothing pending" with a clock-out owed —
  // the exact lie the `after === 0` guard was built for, arriving concurrently instead.
  reset([inItem('c-1')]);
  clock().setPending(entry('', false));
  // An older pill than any live tap can mint, which is also the real shape of this case: the flag
  // was set when the queued shift was captured, minutes ago in a dead zone.
  useClockStore.setState({pendingSince: AT});
  setEntries([entry('server-1', false)]);
  setOnList(() => clock().setPending(null));

  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  assert.equal(lists.length, 1);
  assert.notEqual(
    clock().pendingSince,
    null,
    'the queued clock-in cleared a pill belonging to the clock-out tapped behind it',
  );
  assert.notEqual(clock().pendingSince, AT, 'the live tap never replaced the flag');
  assert.equal(
    clock().openEntry,
    null,
    "the server's pre-tap view put the worker back on shift mid-request",
  );

  stop();
});

test('no trigger fires once the listeners are stopped', async () => {
  // The queue is device-wide, not user-scoped (stores/outbox.ts), so a listener that outlives a
  // sign-out flushes one worker's hours under whoever signs in next.
  reset();
  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();
  stop();

  assert.equal(netHandlerCount(), 0, 'the NetInfo listener outlived the session');
  assert.equal(appHandlerCount(), 0, 'the AppState listener outlived the session');

  outbox().enqueue(inItem('c-1'));
  emitNet({isConnected: false, isInternetReachable: false});
  emitNet({isConnected: true, isInternetReachable: true});
  emitAppState('active');
  await settle();

  assert.equal(sends(), 0, 'a stopped trigger flushed the queue anyway');
  assert.equal(lists.length, 0);
  assert.deepEqual(
    outbox().items.map((i) => i.clientId),
    ['c-1'],
    'the queued shift must still be there for the next sign-in to own or clear',
  );
});

test('a reconnect and a foreground in one tick cost one flush and one reconcile', async () => {
  // Both fire when a phone is unlocked in a dead zone. flush() collapses the requests on its own,
  // but each caller still resolves, and each resolution would otherwise run its own reconcile.
  reset();
  const {startSync} = await freshSync();
  const stop = startSync();
  await settle();

  outbox().enqueue(inItem('c-1'));
  emitNet({isConnected: false, isInternetReachable: false});
  emitNet({isConnected: true, isInternetReachable: true});
  emitAppState('active');
  await settle();

  assert.equal(sends(), 1, 'the same clock-in was sent twice');
  assert.equal(lists.length, 1, 'one reconnect bought two full-history decrypts');

  stop();
});

test('a launch replay is reconciled, not measured against an unread queue', async () => {
  // Relaunch owning a shift the last session could not send. The arming flush is issued before the
  // storage read lands, so without `await hydrated` the depth either side of it is 0 -> 0 — an
  // empty flush — and the reconcile that replay is owed is skipped. Nothing else covers it: the
  // clock store is not persisted, so it has no optimistic entry to revert, and the clock tab's
  // mount hydrate is not ordered after the replay and is not invalidated by it. The worker reads
  // "Clocked out" on a shift the server has just accepted.
  //
  // The one test here that needs a *fresh* outbox: the window closes at module load, and the
  // singleton's closed before the first test ran.
  reset();
  await settle(); // let reset's own persist write land before the stored queue is planted under it
  storage.items.set(
    KEY,
    JSON.stringify({state: {items: [inItem('stored')], needsAttention: []}, version: 0}),
  );
  setEntries([entry('server-1', false)]);

  const release = storage.blockReads();
  outboxTag = 'launch';
  const {startSync} = await freshSync();
  outboxTag = '';

  const stop = startSync();
  await settle();
  assert.equal(sends(), 0, 'the flush ran before the stored queue was readable');

  release();
  await settle();

  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['stored'],
    'the stored shift was never replayed',
  );
  assert.equal(lists.length, 1, 'a launch replay was read as an empty flush and never reconciled');
  assert.equal(clock().openEntry?.id, 'server-1', 'the replayed shift still reads "Clocked out"');

  stop();
});
