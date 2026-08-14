// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts modules under test.
//
// This is the money path: every branch below either loses a worker's hours or pays them twice,
// and none of them can be staged by hand — they need a 500 mid-request, a mocked fix, a 409, a
// response that was lost after the write landed. The flow lives in a plain module (not in the
// screen) precisely so it can be driven here; there is no renderer in this repo.
//
// Stubbed: the four native surfaces (expo-crypto, expo-location, react-native's Alert,
// AsyncStorage) and `fetch`. The real api/client.ts, api/entries.ts, stores/clock.ts,
// stores/outbox.ts and lib/clockFlow.ts are driven — so the wire body, the error parsing and the
// retry classification are the shipped ones, not a second copy that only agrees with itself.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

// Read at module scope by api/client.ts, so it must be set before that import lands.
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';

const src = new URL('../', import.meta.url);
const CRYPTO_STUB = 'stub:expo-crypto';
const RN_STUB = 'stub:react-native';
const LOCATION_STUB = 'stub:expo-location';
const ASYNC_STORAGE_STUB = 'stub:async-storage';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'expo-crypto') return {url: CRYPTO_STUB, shortCircuit: true};
    if (specifier === 'react-native') return {url: RN_STUB, shortCircuit: true};
    if (specifier === 'expo-location') return {url: LOCATION_STUB, shortCircuit: true};
    if (specifier === '@react-native-async-storage/async-storage') {
      return {url: ASYNC_STORAGE_STUB, shortCircuit: true};
    }
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    // Counting, not random: the assertion this file exists for is that one *intent* mints one id
    // and every later send reuses it, which a real UUID could only be checked against by
    // remembering it — this way a second call is visibly a second id.
    if (url === CRYPTO_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          let n = 0;
          export function resetUUID() { n = 0; }
          export function randomUUID() { return 'uuid-' + ++n; }
        `,
      };
    }
    // On ios/android the stub always settles something: it presses a button or fires onDismiss,
    // never both and never neither. Off them it settles *nothing*, because that is what ships —
    // react-native-web replaces this module with a literal no-op ("class Alert { static alert() {}
    // }"), and RN's own Alert.js branches on ios/android and returns having touched no callback
    // for anything else. Modelling the no-op rather than smoothing it over is the whole point: a
    // confirm dialog whose promise never resolves is a clock button that spins for the life of the
    // process, and this is the only place that can fail instead of a worker's phone.
    if (url === RN_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const alerts = [];
          let choice = 'Cancel';
          export const Platform = {OS: 'ios'};
          export const AppState = {currentState: 'active'};
          export function setPlatform(os) { Platform.OS = os; }
          export function setAppState(s) { AppState.currentState = s; }
          export function setAlertChoice(text) { choice = text; }
          export function resetAlerts() {
            alerts.length = 0;
            choice = 'Cancel';
            Platform.OS = 'ios';
            AppState.currentState = 'active';
          }
          export const Alert = {
            alert(title, message, buttons, options) {
              if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
              // A paused Android host stashes the fragment on a FragmentManagerHelper that is
              // minted per access, so onHostResume looks for it on a different instance and finds
              // nothing: the dialog is never shown and no callback ever fires. Modelled as a drop
              // for the same reason the web no-op is — this is the shape that strands the promise.
              if (Platform.OS === 'android' && AppState.currentState !== 'active') return;
              alerts.push({title, message});
              if (!buttons) return;
              const b = buttons.find((x) => x.text === choice);
              if (b?.onPress) b.onPress();
              else options?.onDismiss?.();
            },
          };
        `,
      };
    }
    // The real location/fix.ts runs on top of this, so getFix()'s own mapping (null accuracy,
    // absent mocked, LocationError wrapping) is the shipped one here too.
    if (url === LOCATION_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const Accuracy = {};
          let next = async () => ({});
          export function setNext(fn) { next = fn; }
          export function getCurrentPositionAsync(o) { return next(o); }
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
    return next(url, context);
  },
});

const {resetUUID} = await import(CRYPTO_STUB);
const {alerts, resetAlerts, setAlertChoice, setAppState, setPlatform} = await import(RN_STUB);
const {setNext} = await import(LOCATION_STUB);
const {useClockStore} = await import('@/stores/clock');
const {useOutboxStore} = await import('@/stores/outbox');
const {clockInNow, clockOutNow} = await import('@/lib/clockFlow');

// ---------------------------------------------------------------------------------------------
// fetch is the only seam below api/client.ts, so everything from the request body to ApiError.code
// is the shipped code path.

const requests = [];
let respond = async () => ok({entry: serverEntry()});

globalThis.fetch = async (url, init) => {
  requests.push({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body) : null,
  });
  return respond(url, init);
};

const ok = (obj) => new Response(JSON.stringify(obj), {status: 200});
const fail = (status, code, message, details) =>
  new Response(JSON.stringify({error: {code, message, details}}), {status});
const offline = () => {
  throw new TypeError('fetch failed');
};

const clockRequests = () => requests.filter((r) => r.url.includes('/clock-'));

// ---------------------------------------------------------------------------------------------

const BKK = {lat: 13.7563, lng: 100.5018};
const ANCHOR = {lat: 13.7563, lng: 100.5018};
const AT_MS = 1700000000000;
const AT = new Date(AT_MS).toISOString();

const MEMBERSHIPS = [
  {id: 'm1', status: 'active', employer: {id: 'e1', name: 'Acme Cafe', anchor: ANCHOR, timezone: 'Asia/Bangkok'}},
];

function serverEntry(overrides = {}) {
  return {
    id: 'srv-1',
    client_id: 'uuid-1',
    employer_id: 'e1',
    status: 'open',
    clock_in: {at: AT, loc: BKK, accuracy: 5, mocked: false},
    clock_out: null,
    location_verified: true,
    flags: [],
    created_at: AT,
    ...overrides,
  };
}

function setFix({accuracy = 5, mocked = false} = {}) {
  setNext(async () => ({
    coords: {latitude: BKK.lat, longitude: BKK.lng, accuracy},
    timestamp: AT_MS,
    mocked,
  }));
}

function reset() {
  requests.length = 0;
  respond = async () => ok({entry: serverEntry()});
  resetUUID();
  resetAlerts();
  setFix();
  useClockStore.setState({openEntry: null, lastClosed: null, pendingSince: null});
  useOutboxStore.setState({items: [], needsAttention: []});
}

const clock = () => useClockStore.getState();
const outbox = () => useOutboxStore.getState();

// ============================================================================================
// Idempotency — the one that pays someone twice when it breaks.

test('one tap mints one client_id, and the outbox replay reuses it', async () => {
  reset();
  respond = offline;

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.deepEqual(result, {done: true, message: null}, 'a queued write is still done');
  const [live] = clockRequests();
  assert.equal(live.body.client_id, 'uuid-1');
  assert.equal(clock().openEntry.client_id, 'uuid-1', 'the optimistic entry carries another id');
  assert.equal(outbox().items[0].clientId, 'uuid-1');

  // The replay. If the flow had minted the id per *attempt*, a clock-in whose 201 was lost on the
  // way back would land a second time under a second key: two paid shifts, one worked.
  respond = async () => ok({entry: serverEntry()});
  await outbox().flush();

  const replay = clockRequests()[1];
  assert.equal(replay.body.client_id, 'uuid-1', 'the retry minted a fresh idempotency key');
  assert.equal(replay.body.queued, true, 'the replay must be marked queued or it is refused stale');
});

// ============================================================================================
// Local pre-checks.

test('a mocked fix alerts and sends nothing at all', async () => {
  reset();
  setFix({mocked: true});

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.deepEqual(result, {done: false, message: null});
  assert.equal(clockRequests().length, 0, 'a fix the server always refuses was sent anyway');
  assert.equal(outbox().items.length, 0, 'a guaranteed rejection was parked in the outbox');
  assert.equal(clock().openEntry, null, 'a refused pre-check still wrote optimistic state');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /Mock location/i);
});

test('weak accuracy asks first: cancel sends nothing, "Try anyway" sends', async () => {
  reset();
  setFix({accuracy: 101});

  assert.deepEqual(await clockInNow('e1', MEMBERSHIPS), {done: false, message: null});
  assert.equal(clockRequests().length, 0, 'a cancelled confirm still sent the request');
  assert.equal(clock().openEntry, null);

  // The server owns the verdict, so "try anyway" must reach it rather than be refused locally.
  setAlertChoice('Try anyway');
  assert.equal((await clockInNow('e1', MEMBERSHIPS)).done, true);
  assert.equal(clockRequests().length, 1);
  assert.equal(clockRequests()[0].body.loc.accuracy, 101);
});

// A back press cannot reach this (RN passes a literal cancelable:false), but a fragment teardown
// — a configuration change, the dialog being destroyed — fires ACTION_DISMISSED with no button
// handler, and onDismiss is the only thing listening for it.
test('a dialog torn down without a button settles as cancel', async () => {
  reset();
  setFix({accuracy: 101});
  setAlertChoice('__no_such_button__');

  const result = await Promise.race([
    clockInNow('e1', MEMBERSHIPS),
    new Promise((r) => setTimeout(() => r('STRANDED'), 100)),
  ]);

  assert.notEqual(result, 'STRANDED', 'a dismissed dialog settled nothing — the button spins forever');
  assert.deepEqual(result, {done: false, message: null});
  assert.equal(clockRequests().length, 0);
});

// The confirm dialog is awaited inside the screen's in-flight guard, so a promise only the dialog
// can settle does not merely skip a question — it leaves `inFlight` true and `busy` true forever,
// and the clock button is dead until the process restarts. Raced rather than plainly awaited so
// that regression fails as an assertion here in 100 ms instead of hanging the suite on a timeout.
test('a platform with no dialog settles the tap instead of killing the button', async () => {
  reset();
  setPlatform('web');
  setFix({accuracy: 101});

  const result = await Promise.race([
    clockInNow('e1', MEMBERSHIPS),
    new Promise((r) => setTimeout(() => r('STRANDED'), 100)),
  ]);

  assert.notEqual(result, 'STRANDED', 'the confirm never settled — the clock button is dead for the session');
  // The server owns the accuracy verdict, so a question we could not put to the worker must not
  // be answered "no" on their behalf — that would refuse the clock-in outright.
  assert.equal(result.done, true);
  assert.equal(clockRequests().length, 1);
});

// Same harm on a platform that does have a dialog: a screen-off or app-switch during getFix()'s
// 15 s window puts the host in onHostPause, and a confirm raised from there is stashed on a helper
// that is minted per access — onHostResume reads a different one, finds no pending fragment, and
// the dialog is never shown. No button, no onDismiss, nothing to settle the promise.
test('a paused android host settles the tap instead of stranding on a stashed dialog', async () => {
  reset();
  setPlatform('android');
  setAppState('background');
  setFix({accuracy: 101});

  const result = await Promise.race([
    clockInNow('e1', MEMBERSHIPS),
    new Promise((r) => setTimeout(() => r('STRANDED'), 100)),
  ]);

  assert.notEqual(result, 'STRANDED', 'the confirm never settled — the clock button is dead for the session');
  assert.equal(result.done, true);
  assert.equal(clockRequests().length, 1);
});

// The other half: a resumed android host must still get the real question, or the clause above has
// quietly disabled the confirm on the platform it was written for.
test('a resumed android host still asks, and cancel still sends nothing', async () => {
  reset();
  setPlatform('android');
  setFix({accuracy: 101});

  assert.deepEqual(await clockInNow('e1', MEMBERSHIPS), {done: false, message: null});
  assert.equal(alerts.length, 1, 'the confirm was skipped on a foregrounded android host');
  assert.equal(clockRequests().length, 0, 'a cancelled confirm still sent the request');
});

test('a mocked fix on a platform with no dialog says so inline rather than dying silently', async () => {
  reset();
  setPlatform('web');
  setFix({mocked: true});

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.equal(result.done, false);
  // Without inline copy this tap shows nothing at all: the alert is a no-op and ABORTED's message
  // is null, so the worker taps Clock in and the screen does not react.
  assert.match(result.message, /Mock location/i, 'the tap died silently with nothing on screen');
  assert.equal(clockRequests().length, 0);
  assert.equal(outbox().items.length, 0);
});

test('a fix that cannot be read shows its own copy and queues nothing', async () => {
  reset();
  setNext(async () => {
    throw new Error('kCLErrorDomain');
  });

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.equal(result.done, false);
  // location/fix.ts's LocationError copy, not an ApiError's — there is no fix to send, so this
  // must never be classified as retryable.
  assert.match(result.message, /Could not get your location/);
  assert.ok(!result.message.includes('kCLErrorDomain'), 'leaked native detail');
  assert.equal(clockRequests().length, 0);
  assert.equal(outbox().items.length, 0);
});

// ============================================================================================
// Server verdicts.

test('a 4xx reverts the optimistic write and queues nothing', async () => {
  reset();
  respond = async () =>
    fail(422, 'OUT_OF_RANGE', '1800 m from anchor (limit 150 m)', {distance_m: 1800, limit_m: 150});

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.equal(result.done, false);
  assert.equal(clock().openEntry, null, 'a refused clock-in left the worker on a phantom shift');
  assert.equal(clock().pendingSince, null, 'the "waiting for connection" pill was left up');
  assert.equal(outbox().items.length, 0, 'a permanent refusal was queued for replay');
});

test('a 5xx keeps the optimistic shift and queues the body unmarked', async () => {
  reset();
  respond = async () => fail(500, 'INTERNAL', 'boom');

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.deepEqual(result, {done: true, message: null});
  assert.equal(clock().openEntry.client_id, 'uuid-1', 'the worker was clocked back out');
  assert.notEqual(clock().pendingSince, null, 'nothing tells the worker the write is owed');

  const [item] = outbox().items;
  assert.equal(item.kind, 'clock-in');
  assert.equal(item.body.employer_id, 'e1');
  // `queued` is the flush's to add. Pre-marked here, a live tap would reach the employer flagged
  // `backdated` — and the live request itself must never carry it either.
  assert.equal(item.body.queued, undefined, 'a live tap was queued pre-marked as backdated');
  assert.equal(clockRequests()[0].body.queued, undefined, 'a live tap claimed to be a replay');
});

test('an offline tap is queued, not refused', async () => {
  reset();
  respond = offline;

  assert.equal((await clockInNow(null, [])).done, true);
  assert.equal(outbox().items.length, 1);
  assert.equal(
    'employer_id' in outbox().items[0].body,
    false,
    'a personal entry sent an employer_id key',
  );
});

test('OPEN_ENTRY_EXISTS reverts, tells the worker, and re-asks the server', async () => {
  reset();
  const running = serverEntry({id: 'srv-9', client_id: 'earlier'});
  respond = async (url) =>
    url.includes('/clock-in')
      ? fail(409, 'OPEN_ENTRY_EXISTS', 'an open entry already exists')
      : ok({entries: [running]});

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.equal(result.done, false);
  assert.match(result.message, /already on shift/i, 'the worker was told nothing');

  // The hydrate is deliberately not awaited (it is a 15 s request under a live spinner), so let
  // the microtask queue and the in-flight GET settle before reading the repair.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    requests.some((r) => r.url.includes('/v1/entries') && r.method === 'GET'),
    'no hydrate was triggered — the screen is now stuck 409ing forever',
  );
  assert.equal(clock().openEntry.id, 'srv-9', 'the real open shift was never recovered');
});

// The clock-out mirror of the case above, and the escape from the same loop: the server closed
// this shift by another route, so our "on shift" view is the stale one and every further tap gets
// the same 409 until something re-asks.
test('NO_OPEN_ENTRY reverts, tells the worker, and re-asks the server', async () => {
  reset();
  clock().setOpen(serverEntry({id: 'srv-5', client_id: 'in-5'}));
  respond = async (url) =>
    url.includes('/clock-out')
      ? fail(409, 'NO_OPEN_ENTRY', 'no open entry')
      : ok({
          entries: [
            serverEntry({
              id: 'srv-5',
              status: 'closed',
              clock_out: {at: AT, loc: BKK, accuracy: 5, mocked: false},
            }),
          ],
        });

  const result = await clockOutNow(MEMBERSHIPS);

  assert.equal(result.done, false);
  assert.match(result.message, /not on shift/i, 'the worker was told nothing');

  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    requests.some((r) => r.url.includes('/v1/entries') && r.method === 'GET'),
    'no hydrate was triggered — the screen is now stuck 409ing forever',
  );
  // Also pins the write ordering: the revert runs first and the hydrate takes its ticket after,
  // so the server's answer is the one that survives.
  assert.equal(clock().openEntry, null, 'the revert put the closed shift back and the hydrate lost');
});

test('a truncated 200 is never replayed, and the write that landed is recovered', async () => {
  reset();
  respond = async (url) =>
    url.includes('/clock-in')
      ? // The write landed; only the response was lost on the way back. api() cannot parse it and
        // raises ApiError(200, 'UNKNOWN') — non-retryable precisely so no replay can double the
        // shift, which leaves a hydrate as the only way the entry is ever seen again.
        new Response('{"entry":{"id":"srv-7"', {status: 200})
      : ok({entries: [serverEntry({id: 'srv-7', client_id: 'uuid-1'})]});

  const result = await clockInNow('e1', MEMBERSHIPS);

  assert.equal(result.done, false);
  assert.equal(outbox().items.length, 0, 'a write that already landed was queued — the shift is paid twice');
  assert.match(
    result.message,
    /checking with the server/i,
    "client.ts's developer copy was shown to a worker whose clock-in had in fact succeeded",
  );

  await new Promise((r) => setTimeout(r, 0));
  assert.ok(clock().openEntry, 'no hydrate — the shift that landed is invisible and every tap now 409s');
  assert.equal(clock().openEntry.id, 'srv-7');
});

test('a hydrate that fails does not swallow the refusal or reject', async () => {
  reset();
  respond = async (url) => {
    if (url.includes('/clock-in')) return fail(409, 'OPEN_ENTRY_EXISTS', 'an open entry already exists');
    throw new TypeError('fetch failed');
  };

  const result = await clockInNow('e1', MEMBERSHIPS);
  await new Promise((r) => setTimeout(r, 0));

  assert.match(result.message, /already on shift/i);
  assert.equal(clock().openEntry, null, 'a failed hydrate invented state');
});

// ============================================================================================
// Clock-out.

test('a refused clock-out gives the running shift back', async () => {
  reset();
  const running = serverEntry({id: 'srv-2', client_id: 'in-1'});
  clock().setOpen(running);
  respond = async () => fail(422, 'LOW_ACCURACY', 'GPS accuracy too low');

  const result = await clockOutNow(MEMBERSHIPS);

  assert.equal(result.done, false);
  assert.equal(clock().openEntry, running, 'a refused clock-out lost the shift being worked');
  assert.equal(clock().pendingSince, null);
  assert.equal(outbox().items.length, 0);
});

test('a queued clock-out carries the open entry key, even when the entry is itself queued', async () => {
  reset();
  respond = offline;

  // Clock in offline, then out offline: the "open" entry is an optimistic one no server has seen.
  await clockInNow('e1', MEMBERSHIPS);
  await clockOutNow(MEMBERSHIPS);

  const [, out] = outbox().items;
  assert.equal(out.kind, 'clock-out');
  assert.equal(out.clientId, 'uuid-2', 'the close reused the clock-in key');
  // The server stores a close under close_client_id and never emits it, so this is the only way
  // 7.1 can join a rejected clock-out back to a row.
  assert.equal(out.entryClientId, 'uuid-1', 'the close cannot be matched to its entry');
  assert.equal(clock().openEntry, null, 'the shift did not end locally');
});

// prepare() spends up to 15 s in getFix() plus an open-ended dialog, and the entry a refusal
// reverts to must be the one that is true when the refusal arrives, not the one that was true
// when the tap started.
test('a clock-out refused after a mid-flight hydrate reverts to the hydrated shift', async () => {
  reset();
  respond = offline;
  await clockInNow('e1', MEMBERSHIPS);
  assert.equal(clock().openEntry.id, '', 'precondition: the open shift is the optimistic one');

  const real = serverEntry({id: 'srv-REAL', client_id: 'uuid-1'});
  respond = async (url) =>
    url.includes('/clock-out') ? fail(422, 'LOW_ACCURACY', 'nope') : ok({entries: [real]});
  // The flush (or a 9.1 hydrate) lands *during* the clock-out's GPS read and replaces the
  // optimistic entry with the server's.
  setNext(async () => {
    await clock().hydrateFromServer();
    return {coords: {latitude: BKK.lat, longitude: BKK.lng, accuracy: 5}, timestamp: AT_MS, mocked: false};
  });

  const result = await clockOutNow(MEMBERSHIPS);

  assert.equal(result.done, false);
  assert.equal(
    clock().openEntry.id,
    'srv-REAL',
    'the revert restored the pre-await copy: id "" is a dead /entry/[id] route (7.2) carrying a stale location_verified',
  );
});

// The summary on the clocked-out card reads `lastClosed`, and nothing re-fetches on a successful
// clock-out — so a close that only cleared `openEntry` would leave the *previous* shift on screen
// until the next launch hydrate. The stale seed is what makes this non-vacuous.
test('an accepted clock-out clears the shift and becomes the last shift', async () => {
  reset();
  const stale = serverEntry({
    id: 'srv-OLD',
    status: 'closed',
    clock_out: {at: AT, loc: BKK, accuracy: 5, mocked: false},
  });
  useClockStore.setState({lastClosed: stale});
  clock().setOpen(serverEntry({id: 'srv-3', client_id: 'in-3'}));
  const closed = serverEntry({
    id: 'srv-3',
    client_id: 'in-3',
    status: 'closed',
    clock_out: {at: AT, loc: BKK, accuracy: 5, mocked: false},
  });
  respond = async () => ok({entry: closed});

  assert.deepEqual(await clockOutNow(MEMBERSHIPS), {done: true, message: null});
  assert.equal(clock().openEntry, null);
  assert.equal(clock().pendingSince, null);
  assert.deepEqual(
    clock().lastClosed,
    closed,
    'the card still shows the previous shift — the closed entry the server returned was discarded',
  );
});

// ============================================================================================
// The error map. Copy is the whole product here: a worker who cannot read what to do next is
// stuck at the door of a building they are already standing outside.

const CASES = [
  ['MOCKED_LOCATION', {}, 'Mock location detected — disable fake GPS apps.'],
  ['LOW_ACCURACY', {}, 'GPS accuracy too low — step outside and retry.'],
  ['STALE_TIMESTAMP', {}, 'Device clock looks wrong — check date & time.'],
  [
    'QUEUED_TOO_OLD',
    {},
    'This shift waited too long to sync — ask your employer to add it manually.',
  ],
  // limit_m over the plan's literal "1 km": ANCHOR_RADIUS_M is a deployment-wide env var this app
  // keeps a stale copy of, and sending someone 1 km when the server enforces 150 m sends them
  // somewhere that will be refused again.
  [
    'OUT_OF_RANGE',
    {distance_m: 1800, limit_m: 150},
    "You're 1.8 km from Acme Cafe — move within 150 m.",
  ],
  // details is Record<string, unknown> off the wire: a malformed payload must never render
  // "undefined" at someone who is trying to start work.
  ['OUT_OF_RANGE', {}, "You're too far from Acme Cafe — move within 1.0 km."],
  ['OUT_OF_RANGE', {distance_m: 'far'}, "You're too far from Acme Cafe — move within 1.0 km."],
];

for (const [code, details, expected] of CASES) {
  test(`maps ${code} ${JSON.stringify(details)} to its copy`, async () => {
    reset();
    respond = async () => fail(422, code, 'server copy that must not be shown', details);

    const {message} = await clockInNow('e1', MEMBERSHIPS);
    assert.equal(message, expected);
  });
}

test('an unmapped code falls through to the server message', async () => {
  reset();
  respond = async () => fail(403, 'NOT_MEMBER', 'not a member of this employer');

  const {message} = await clockInNow('e1', MEMBERSHIPS);
  assert.equal(message, 'not a member of this employer');
});

test('OUT_OF_RANGE names the shift location for a personal entry and a revoked membership', async () => {
  reset();
  respond = async () => fail(422, 'OUT_OF_RANGE', 'x', {distance_m: 500, limit_m: 100});

  assert.match((await clockInNow(null, [])).message, /from your shift location —/);

  reset();
  respond = async () => fail(422, 'OUT_OF_RANGE', 'x', {distance_m: 500, limit_m: 100});
  // A membership can be revoked while its shift is still running; "undefined" must not appear.
  assert.match((await clockInNow('gone', MEMBERSHIPS)).message, /from your employer —/);
});
