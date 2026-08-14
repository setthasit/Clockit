// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts modules under test.
//
// What is worth testing here is not the native calls — it is the decision in front of them: when
// the phone should be recording a shift and when it must stop. That decision is a subscription to
// a store, so every case below is a store write and an assertion about what the OS was asked to
// do, including the two that cost a worker or their employer something real: a shift that keeps
// pinging after clock-out, and a foreground service left running by a shift closed elsewhere.
//
// One module instance, driven in sequence. Importing a second copy (`?tag`) would leave two
// subscriptions on the same singleton store, and every later write would be counted twice.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

// Read at module scope by api/client.ts, which stores/outbox.ts pulls in for ApiError.
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';

const src = new URL('../', import.meta.url);
const LOCATION_STUB = 'stub:expo-location';
const TASK_MANAGER_STUB = 'stub:expo-task-manager';
const CRYPTO_STUB = 'stub:expo-crypto';
const ASYNC_STORAGE_STUB = 'stub:async-storage';
const ENTRIES_STUB = 'stub:api-entries';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'expo-location') return {url: LOCATION_STUB, shortCircuit: true};
    if (specifier === 'expo-task-manager') return {url: TASK_MANAGER_STUB, shortCircuit: true};
    if (specifier === 'expo-crypto') return {url: CRYPTO_STUB, shortCircuit: true};
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
    // Records what was asked of the OS rather than pretending to be it. `started` is the OS's own
    // memory of the task, which outlives the JS context — the whole reason the module consults it
    // instead of trusting a flag of its own.
    if (url === LOCATION_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const calls = [];
          export let started = false;
          export let background = 'undetermined';
          export function setStarted(v) { started = v; }
          export function setBackground(v) { background = v; }
          export function reset() { calls.length = 0; }
          export const PermissionStatus = {
            GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined',
          };
          export const Accuracy = {Balanced: 3, Highest: 5};
          export async function getBackgroundPermissionsAsync() {
            calls.push({fn: 'getBackgroundPermissions'});
            return {status: background, granted: background === 'granted', canAskAgain: true};
          }
          export async function requestBackgroundPermissionsAsync() {
            calls.push({fn: 'requestBackgroundPermissions'});
            return {status: background, granted: background === 'granted', canAskAgain: true};
          }
          export async function hasStartedLocationUpdatesAsync(task) {
            calls.push({fn: 'hasStarted', task});
            return started;
          }
          export async function startLocationUpdatesAsync(task, options) {
            calls.push({fn: 'start', task, options});
            started = true;
          }
          export async function stopLocationUpdatesAsync(task) {
            calls.push({fn: 'stop', task});
            started = false;
          }
        `,
      };
    }
    // Captures the executor so the OS delivery can be driven from a test; the real module hands
    // it to native code no test can reach.
    if (url === TASK_MANAGER_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          let executor = null;
          export let definedAs = null;
          export function defineTask(name, fn) { definedAs = name; executor = fn; }
          export function deliver(body) { return executor(body); }
        `,
      };
    }
    if (url === CRYPTO_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `let n = 0; export function randomUUID() { return 'uuid-' + ++n; }`,
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
            setItem: async (k, v) => void items.set(k, v),
            removeItem: async (k) => void items.delete(k),
          };
        `,
      };
    }
    // The queue's send functions. postPings records what a flush would have put on the wire.
    if (url === ENTRIES_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const sent = [];
          export const MAX_PING_BATCH = 64;
          export async function postPings(pings) { sent.push(pings); return pings.length; }
          export async function clockIn() { throw new Error('not used'); }
          export async function clockOut() { throw new Error('not used'); }
          // stores/clock.ts's hydrate. Never called here — the tests write the store directly —
          // but the import has to resolve or the store cannot load.
          export async function listEntries() { return []; }
        `,
      };
    }
    return next(url, context);
  },
});

const location = await import(LOCATION_STUB);
const taskManager = await import(TASK_MANAGER_STUB);
const entries = await import(ENTRIES_STUB);
const {useClockStore} = await import(new URL('stores/clock.ts', src).href);
const tracking = await import(new URL('location/tracking.ts', src).href);

// A macrotask turn: it drains every microtask the serialized start/stop chain is made of, so an
// assertion never races the work a store write kicked off.
const settle = () => new Promise((r) => setTimeout(r, 0));

const entry = (id) => ({
  id,
  client_id: id,
  employer_id: 'emp-1',
  status: 'open',
  clock_in: {at: '2026-08-14T09:00:00.000Z', loc: {lat: 49.28, lng: -123.12}, accuracy: 8, mocked: false},
  clock_out: null,
  location_verified: true,
  flags: [],
  created_at: '2026-08-14T09:00:00.000Z',
});

const names = () => location.calls.map((c) => c.fn);

test('the task is registered under the name the OS holds it by', () => {
  assert.equal(taskManager.definedAs, 'clockit-shift-tracking');
});

// The launch case the plan calls a defensive stop: Android keeps the foreground service across a
// kill (killServiceOnDestroy: false), so a shift closed from another device would otherwise leave
// the phone pinging — and the notification up — for a shift that ended.
test('a launch that finds no open shift stops a service left running', async () => {
  location.setBackground('granted');
  location.setStarted(true);
  location.reset();

  useClockStore.getState().setOpen(null);
  await settle();

  assert.deepEqual(names(), ['hasStarted', 'stop']);
  assert.equal(location.started, false);
});

test('going on shift starts updates at the ten-minute cadence', async () => {
  location.reset();
  useClockStore.getState().setOpen(entry('e-1'));
  await settle();

  assert.deepEqual(names(), ['getBackgroundPermissions', 'hasStarted', 'start']);
  const {task, options} = location.calls.at(-1);
  assert.equal(task, 'clockit-shift-tracking');
  assert.equal(options.timeInterval, 600_000);
  assert.equal(options.deferredUpdatesInterval, 600_000);
  // Android's persistent notification is not decoration: it is the honest disclosure that the
  // phone is recording, and the service that makes the cadence hold at all.
  assert.equal(options.foregroundService.notificationTitle, 'On shift');
  assert.equal(options.foregroundService.killServiceOnDestroy, false);
});

// Every hydrate parses a fresh object, so identity changes constantly while nothing does.
test('a further write while still on shift asks the OS nothing', async () => {
  location.reset();
  useClockStore.getState().setOpen(entry('e-1'));
  useClockStore.getState().setPending(entry('e-1'));
  await settle();

  assert.deepEqual(names(), []);
});

test('clocking out stops updates', async () => {
  location.reset();
  useClockStore.getState().setClosed({...entry('e-1'), status: 'closed'});
  await settle();

  assert.deepEqual(names(), ['hasStarted', 'stop']);
  assert.equal(location.started, false);
});

// A declined Always permission is a supported shift, not a failure: the clock events still record
// the hours. What must not happen is a prompt raised from a store subscription with no
// explanation on screen — so the module reads the permission and never requests it.
test('a shift without background permission starts nothing and asks nothing', async () => {
  location.setBackground('denied');
  location.reset();
  useClockStore.getState().setOpen(entry('e-2'));
  await settle();

  assert.deepEqual(names(), ['getBackgroundPermissions']);
  assert.equal(location.started, false);
});

// Granting mid-shift is the Android 11+ path (the request opens Settings) and the "changed my
// mind in Settings months later" path. The subscription cannot catch either: being on shift is
// what it has already latched.
test('permission granted mid-shift starts tracking without a clock event', async () => {
  location.setBackground('granted');
  location.reset();

  assert.equal(await tracking.requestShiftTracking(), true);
  await settle();

  assert.deepEqual(names(), ['requestBackgroundPermissions', 'getBackgroundPermissions', 'hasStarted', 'start']);
});

test('a refused request starts nothing and reports the refusal', async () => {
  location.setBackground('denied');
  location.setStarted(false);
  location.reset();

  assert.equal(await tracking.requestShiftTracking(), false);
  await settle();

  assert.deepEqual(names(), ['requestBackgroundPermissions']);
});

test('a delivery becomes one queued batch and is flushed', async () => {
  entries.sent.length = 0;
  await taskManager.deliver({
    data: {
      locations: [
        {coords: {latitude: 49.28, longitude: -123.12, accuracy: 24}, timestamp: 1_776_000_000_000},
        // No accuracy from the platform: omitted rather than invented, because the server reads
        // it off a ping and drops it.
        {coords: {latitude: 49.29, longitude: -123.13, accuracy: null}, timestamp: 1_776_000_600_000},
      ],
    },
    error: null,
  });

  assert.equal(entries.sent.length, 1, 'the batch was not flushed');
  assert.deepEqual(entries.sent[0], [
    {at: '2026-04-12T13:20:00.000Z', loc: {lat: 49.28, lng: -123.12, accuracy: 24}},
    {at: '2026-04-12T13:30:00.000Z', loc: {lat: 49.29, lng: -123.13, accuracy: undefined}},
  ]);
});

// Permission revoked mid-shift, or location switched off: there is nothing to queue and nothing
// on screen to say it on, so the delivery is skipped rather than turned into an empty batch the
// outbox would carry forever.
test('a failed delivery queues nothing', async () => {
  entries.sent.length = 0;
  await taskManager.deliver({data: null, error: {code: 'E_LOCATION', message: 'denied'}});
  await taskManager.deliver({data: {locations: []}, error: null});

  assert.deepEqual(entries.sent, []);
});
