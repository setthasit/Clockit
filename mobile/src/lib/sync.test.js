// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts modules under test.
//
// The triggers are the last thing between a queued clock-in and the server, and every branch below
// needs something no hand can stage: a NetInfo stream that repeats itself, a queue that drains
// halfway, a foreground and a reconnect landing in the same tick. The real stores/outbox.ts,
// stores/clock.ts and lib/sync.ts are driven; only the two native event sources, AsyncStorage and
// the endpoint functions are stubbed.
//
// Each test imports its own copy of sync.ts (`?tag`), because the launch flush is once per
// *process* by design. The stores it imports resolve to the same URLs, so they stay singletons —
// which is the point: it is the real queue being drained each time.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const NETINFO_STUB = 'stub:netinfo';
const RN_STUB = 'stub:react-native';
const ASYNC_STORAGE_STUB = 'stub:async-storage';
const ENTRIES_STUB = 'stub:api-entries';

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
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    // Modelled on the shipped State class, and the one behaviour that matters is the one a naive
    // stub would smooth over: `add` hands a brand-new subscriber the latest state *immediately*
    // (state.ts `add` -> `handler(this._latestState)`), so subscribing while online delivers
    // `isConnected: true` with nothing having transitioned. Repeats are not filtered either —
    // `_handleNativeStateUpdate` forwards every native event — hence `emit` with no equality check.
    if (url === NETINFO_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const handlers = new Set();
          let latest = {isConnected: true, isInternetReachable: true};
          export function setLatest(s) { latest = s; }
          export function emitNet(s) { latest = s; for (const h of [...handlers]) h(s); }
          export function netHandlerCount() { return handlers.size; }
          export default {
            addEventListener(handler) {
              handlers.add(handler);
              handler(latest);
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
          const items = new Map();
          export default {
            getItem: async (k) => items.get(k) ?? null,
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
          export function setResponder(fn) { responder = fn; }
          export function setEntries(e) { entries = e; }
          export function resetCalls() { calls.length = 0; lists.length = 0; }
          export function clockIn(body) { calls.push(['clock-in', body]); return responder('clock-in', body); }
          export function clockOut(body) { calls.push(['clock-out', body]); return responder('clock-out', body); }
          export function postPings(pings) { calls.push(['pings', pings]); return responder('pings', pings); }
          export async function listEntries() { lists.push(Date.now()); return entries; }
        `,
      };
    }
    return next(url, context);
  },
});

const {emitNet, netHandlerCount, setLatest} = await import(NETINFO_STUB);
const {appHandlerCount, emitAppState} = await import(RN_STUB);
const {calls, lists, resetCalls, setEntries, setResponder} = await import(ENTRIES_STUB);
const {ApiError} = await import('@/api/client');
const {useClockStore} = await import('@/stores/clock');
const {useOutboxStore} = await import('@/stores/outbox');

const AT = '2026-02-13T09:00:00Z';

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
  setLatest({isConnected: true, isInternetReachable: true});
  useOutboxStore.setState({items, needsAttention: []});
  clock().reset();
}

const sends = () => calls.length;

test('the launch flush drains the queue once per process, not once per session', async () => {
  // "Successful launch after loadMe()", and the *once* is the loop guard: `me` is cleared by
  // onUnauthorized and reloaded by the gate, so a flush tied to every arrival of `me` closes a
  // loop through a 401 — flush 401s, me is cleared, me is reloaded, flush 401s — against an
  // endpoint that is already refusing us. AppState and NetInfo still replay the queue.
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

  assert.equal(sends(), 1, 're-arming the triggers flushed again — a 401 would loop here');
  stopAgain();
});

test('a transition to connected flushes; the subscribe event and a repeat do not', async () => {
  // The plan says *transition* to true, and both halves are real: NetInfo hands a new subscriber
  // the current state immediately, and it forwards every native event without deduping, so a
  // phone hopping cell towers repeats "connected" all day.
  reset();
  const {startSync} = await freshSync();
  // The launch flush is spent on an empty queue first, so what the queued clock-in below is
  // exposed to is the *subscribe* event alone.
  startSync()();
  await settle();

  outbox().enqueue(inItem('c-1'));
  const stop = startSync();
  await settle();
  assert.equal(sends(), 0, 'the subscribe event was treated as a transition to connected');

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
