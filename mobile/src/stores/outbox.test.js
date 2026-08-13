// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts module under test.
//
// Every branch below is a way to lose a worker's hours, and none of them can be staged by hand:
// they need a 429 mid-flush, a truncated 200, a storage read that has not landed yet, or two
// triggers firing in the same tick. The real zustand, the real persist and the real outbox.ts are
// driven; only AsyncStorage and the four endpoint functions are stubbed.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const ASYNC_STORAGE_STUB = 'stub:async-storage';
const ENTRIES_STUB = 'stub:api-entries';

registerHooks({
  resolve(specifier, context, next) {
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
    // A Map behind three async methods is the whole contract createJSONStorage needs. `blockReads`
    // exists to hold the getItem promise open: the rehydration window is otherwise already drained
    // by the time an `await import()` returns, and that window is where a queued clock-in dies.
    if (url === ASYNC_STORAGE_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const items = new Map();
          let gate = null;
          export function blockReads() {
            let release;
            gate = new Promise((r) => (release = r));
            return () => { gate = null; release(); };
          }
          export default {
            // Snapshot at call time, then stall: AsyncStorage runs operations on a serial queue
            // (Android SerialExecutor, iOS module method queue), so a read issued first sees the
            // value a later write has not replaced yet. Only its *resolution* is delayed.
            getItem: async (k) => { const v = items.get(k) ?? null; if (gate) await gate; return v; },
            setItem: async (k, v) => { items.set(k, v); },
            removeItem: async (k) => { items.delete(k); },
          };
        `,
      };
    }
    // api/entries.ts reaches api/client.ts and the fetch/env surface behind it. What stays
    // unverified here is the wire itself — that the server really accepts `queued` and really
    // answers 429 where this assumes it does.
    if (url === ENTRIES_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const MAX_PING_BATCH = 64;
          export const calls = [];
          let responder = async () => ({});
          export function setResponder(fn) { responder = fn; }
          export function resetCalls() { calls.length = 0; responder = async () => ({}); }
          export function clockIn(body) { calls.push(['clock-in', body]); return responder('clock-in', body); }
          export function clockOut(body) { calls.push(['clock-out', body]); return responder('clock-out', body); }
          export function postPings(pings) { calls.push(['pings', pings]); return responder('pings', pings); }
        `,
      };
    }
    return next(url, context);
  },
});

const storage = await import(ASYNC_STORAGE_STUB);
const {calls, resetCalls, setResponder} = await import(ENTRIES_STUB);
const {ApiError} = await import('@/api/client');
const {useOutboxStore} = await import('@/stores/outbox');

const KEY = 'clockit-outbox';
const AT = '2026-02-13T09:00:00Z';

// Enough turns for persist's getItem -> merge -> onRehydrateStorage chain. Real timers, so a hang
// fails an assertion instead of hanging the suite.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
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
const pingItem = (id, n) => ({
  kind: 'pings',
  clientId: id,
  queuedAt: AT,
  body: Array.from({length: n}, () => ({at: AT, loc: {lat: 49.28, lng: -123.12}})),
});

const outbox = () => useOutboxStore.getState();

function reset(items = []) {
  resetCalls();
  useOutboxStore.setState({items, needsAttention: []});
}

const rejectWith = (status, code) =>
  setResponder(async () => {
    throw new ApiError(status, code, `${code} (${status})`);
  });

// The classifier is the whole file in one table: retrying costs a duplicate the server dedupes,
// dropping costs a worker their hours. 200/UNKNOWN is the case a 4xx/5xx if-chain misses — the
// write landed behind a truncated body, so a retry would double the shift.
const CASES = [
  [0, 'NETWORK', 'retry'],
  [429, 'RATE_LIMITED', 'retry'], // a FIFO flush after an offline shift bursts past 30/min
  [500, 'INTERNAL', 'retry'],
  [503, 'UNAVAILABLE', 'retry'],
  [400, 'CONFIG', 'drop'], // EXPO_PUBLIC_API_URL is build-time: retrying parks the queue forever
  [401, 'UNAUTHENTICATED', 'drop'],
  [403, 'FORBIDDEN', 'drop'],
  [409, 'OPEN_ENTRY_EXISTS', 'drop'],
  [422, 'QUEUED_TOO_OLD', 'drop'],
  [200, 'UNKNOWN', 'drop'],
];

for (const [status, code, verdict] of CASES) {
  test(`${status} ${code} -> ${verdict}`, async () => {
    reset([inItem('c-1')]);
    rejectWith(status, code);

    await outbox().flush();

    if (verdict === 'retry') {
      assert.deepEqual(
        outbox().items.map((i) => i.clientId),
        ['c-1'],
        `a ${status} dropped a clock-in that should have been retried`,
      );
      assert.deepEqual(outbox().needsAttention, []);
    } else {
      assert.deepEqual(outbox().items, [], `a ${status} left an unsendable item queued forever`);
      assert.equal(outbox().needsAttention.length, 1);
      assert.equal(outbox().needsAttention[0].code, code);
    }
  });
}

test('a retryable failure stops the drain instead of skipping ahead', async () => {
  // A clock-out sent before its own clock-in has no open entry to close: the server 4xxs it and
  // this file drops it. Order is a correctness rule, so the head failing must halt everything.
  reset([inItem('c-1'), outItem('close-1', 'c-1'), pingItem('p-1', 3)]);
  rejectWith(0, 'NETWORK');

  await outbox().flush();

  assert.equal(calls.length, 1, 'the flush kept going past a failed head');
  assert.equal(calls[0][0], 'clock-in');
  assert.deepEqual(
    outbox().items.map((i) => i.clientId),
    ['c-1', 'close-1', 'p-1'],
    'FIFO order was not preserved',
  );
});

test('accepted items leave in order and the queue resumes where it stopped', async () => {
  reset([inItem('c-1'), outItem('close-1', 'c-1'), pingItem('p-1', 3)]);
  setResponder(async (kind) => {
    if (kind === 'clock-out') throw new ApiError(500, 'INTERNAL', 'boom');
    return {};
  });

  await outbox().flush();

  assert.deepEqual(
    calls.map((c) => c[0]),
    ['clock-in', 'clock-out'],
  );
  assert.deepEqual(
    outbox().items.map((i) => i.clientId),
    ['close-1', 'p-1'],
  );
});

test('a replayed clock item is sent with queued: true, pings untouched', async () => {
  reset([inItem('c-1'), outItem('close-1', 'c-1'), pingItem('p-1', 2)]);

  await outbox().flush();

  // Without this the server rejects anything replayed more than MAX_CLOCK_SKEW late as
  // STALE_TIMESTAMP — a 4xx, which this file drops. The close needs it as much as the open: its
  // past bound is lifted only when queued.
  assert.equal(calls[0][1].queued, true, 'a replayed clock-in was sent as if it were a live tap');
  assert.equal(calls[1][1].queued, true, 'a replayed clock-out was sent as if it were a live tap');
  assert.equal(calls[2][1].length, 2, 'pings must be sent verbatim — there is no queued flag');
  assert.equal(calls[2][1][0].queued, undefined);
});

test('a rejected clock-out is recorded against the entry row 7.1 can find', async () => {
  // The server stores a close under close_client_id and never emits it, so Entry.client_id is
  // always the clock-in id. Keyed on the close id, the amber icon would never light.
  reset([outItem('close-1', 'c-1')]);
  rejectWith(422, 'STALE_TIMESTAMP');

  await outbox().flush();

  assert.deepEqual(outbox().needsAttention, [
    {
      kind: 'clock-out',
      clientId: 'close-1',
      entryClientId: 'c-1',
      code: 'STALE_TIMESTAMP',
      message: 'STALE_TIMESTAMP (422)',
    },
  ]);
});

test('a rejected clock-in is recorded against itself, a rejected ping batch against no row', async () => {
  reset([inItem('c-1'), pingItem('p-1', 2)]);
  rejectWith(400, 'INVALID');

  await outbox().flush();

  assert.deepEqual(
    outbox().needsAttention.map((a) => [a.kind, a.clientId, a.entryClientId]),
    [
      ['clock-in', 'c-1', 'c-1'],
      ['pings', 'p-1', null],
    ],
  );
  assert.deepEqual(outbox().items, []);

  outbox().clearAttention();
  assert.deepEqual(outbox().needsAttention, []);
});

test('two triggers in the same tick do not double-send', async () => {
  // NetInfo->true and AppState->active both fire when a phone is unlocked in a dead zone.
  reset([inItem('c-1')]);
  let accept;
  setResponder(() => new Promise((r) => (accept = () => r({}))));

  const first = outbox().flush();
  const second = outbox().flush();
  await settle();

  assert.equal(calls.length, 1, 'the same clock-in was sent twice');
  // Joining, not returning early: 9.1 follows `await flush()` with hydrateFromServer(), and a
  // no-op resolve would hydrate against a server that has not seen the queue yet.
  assert.equal(first, second);

  accept();
  await Promise.all([first, second]);
  assert.deepEqual(outbox().items, []);
});

test('an oversized ping batch is split at enqueue, so no chunk can be rejected whole', async () => {
  // The server rejects a batch over 64 with a 400 — non-retryable, so an unsplit item would be
  // dropped outright.
  reset();
  outbox().enqueue(pingItem('p', 150));

  assert.deepEqual(
    outbox().items.map((i) => [i.clientId, i.body.length]),
    [
      ['p-0', 64],
      ['p-1', 64],
      ['p-2', 22],
    ],
  );
});

test('a flush called before rehydration waits for the stored queue', async () => {
  storage.items.set(
    KEY,
    JSON.stringify({state: {items: [inItem('stored')], needsAttention: []}, version: 0}),
  );
  resetCalls();

  const release = storage.blockReads();
  const {useOutboxStore: store} = await import(new URL('./outbox.ts?cold', import.meta.url).href);
  const flushing = store.getState().flush();
  await settle();
  // Without the wait this would have resolved against an empty in-memory queue and reported a
  // successful sync while a shift sat in storage.
  assert.equal(calls.length, 0, 'the flush ran before the stored queue was readable');

  release();
  await flushing;
  assert.deepEqual(
    calls.map((c) => c[1].client_id),
    ['stored'],
  );
});

test('an item queued during the rehydration window survives it', async () => {
  // Launch in a dead zone, tap clock-in before the storage read lands. persist replaces state
  // wholesale on rehydrate, so a default merge eats this tap silently.
  storage.items.set(
    KEY,
    JSON.stringify({state: {items: [inItem('stored')], needsAttention: []}, version: 0}),
  );
  resetCalls();

  const release = storage.blockReads();
  const {useOutboxStore: store} = await import(new URL('./outbox.ts?window', import.meta.url).href);
  store.getState().enqueue(inItem('tapped'));
  release();
  await settle();

  assert.deepEqual(
    store.getState().items.map((i) => i.clientId),
    ['stored', 'tapped'],
    'the rehydrate wiped a clock-in tapped during the launch window',
  );
  // The tap's own write already replaced storage with the pre-merge list, and persist does not
  // write after merging, so without the re-persist the recovered shift would not survive a kill.
  assert.deepEqual(
    JSON.parse(storage.items.get(KEY)).state.items.map((i) => i.clientId),
    ['stored', 'tapped'],
    'the merged queue was never written back to storage',
  );
});

test('a storage read that never returns data still lets the queue work', async () => {
  storage.items.clear();
  resetCalls();

  const {useOutboxStore: store} = await import(new URL('./outbox.ts?empty', import.meta.url).href);
  store.getState().enqueue(inItem('c-1'));
  await store.getState().flush();

  assert.deepEqual(store.getState().items, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(storage.items.get(KEY)).state.items, []);
});
