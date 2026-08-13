// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts module under test.
//
// distanceM must agree with backend/internal/entry/geo.go haversineM to the metre, or the badge
// says "in range" and the clock-in comes back OUT_OF_RANGE. Every expected value below was
// produced by running that Go function verbatim (go run, math only) — not by a second JS
// implementation, which would only prove this file agrees with itself.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const EXPO_LOCATION_STUB = 'stub:expo-location';

// fix.ts imports expo-location for getFix(), and that package pulls in react-native, which bare
// Node cannot parse. The specifier is redirected to a stub whose getCurrentPositionAsync each
// test sets, which covers getFix()'s mapping without a device — the native call itself, the
// permission prompt and the timeout duration stay unverified here.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'expo-location') return {url: EXPO_LOCATION_STUB, shortCircuit: true};
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== EXPO_LOCATION_STUB) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export const Accuracy = {};
        export let next;
        export function setNext(fn) { next = fn; }
        export function getCurrentPositionAsync(options) { return next(options); }
      `,
    };
  },
});

const {distanceM, getFix, inRange, LocationError} = await import('@/location/fix');
const {setNext} = await import(EXPO_LOCATION_STUB);

// Sub-millimetre: the two implementations are the same expression over the same doubles, so
// anything looser would hide a real divergence (a different radius, a dropped clamp).
const TOLERANCE_M = 1e-6;

const BKK = {lat: 13.7563, lng: 100.5018};

// [name, a, b, metres from the Go haversineM]
const GO_CASES = [
  ['identical points', BKK, BKK, 0],
  ['7.5 m apart', BKK, {lat: 13.7563, lng: 100.50187}, 7.560378243],
  ['11 m north', BKK, {lat: 13.7564, lng: 100.5018}, 11.119492664],
  ['just inside a 1 km anchor', BKK, {lat: 13.7563, lng: 100.511}, 993.649711911],
  ['a few km across Bangkok', BKK, {lat: 13.765, lng: 100.538}, 4027.62809009],
  ['London to Paris', {lat: 51.5007, lng: -0.1246}, {lat: 48.8584, lng: 2.2945}, 340538.92007188],
  [
    'Sydney to New York',
    {lat: -33.8688, lng: 151.2093},
    {lat: 40.7128, lng: -74.006},
    15988755.507039625,
  ],
  // Both drive sqrt(a) to exactly 1.0 — the edge the min(1, ...) clamp guards, where any float
  // overshoot makes asin return NaN and every downstream comparison silently go false. Measured:
  // sqrt(a) === 1 here rather than > 1, so these pin the half-circumference value; the clamp
  // itself stays defensive, exactly as it is in Go.
  ['antipodal on the equator', {lat: 0, lng: 0}, {lat: 0, lng: 180}, 20015086.79602057],
  ['pole to pole', {lat: 90, lng: 0}, {lat: -90, lng: 0}, 20015086.79602057],
];

for (const [name, a, b, expected] of GO_CASES) {
  test(`distanceM matches Go: ${name}`, () => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const got = distanceM(from, to);
      assert.ok(
        Number.isFinite(got) && Math.abs(got - expected) <= TOLERANCE_M,
        `expected ${expected} m, got ${got} m`,
      );
    }
  });
}

// The server compares at whole-metre resolution (WithinAnchor) so a fix on the radius is not
// refused. Both offsets are Go-verified: 1000.302844765 m rounds to 1000, 1000.702464757 to 1001.
test('inRange rounds to whole metres, like the server', () => {
  assert.equal(inRange({lat: 13.7563, lng: 100.5018 + 0.0092616}, BKK), true);
  assert.equal(inRange({lat: 13.7563, lng: 100.5018 + 0.0092653}, BKK), false);
  assert.equal(inRange(BKK, BKK), true);
  assert.equal(inRange({lat: 13.765, lng: 100.538}, BKK), false);
});

// Both platforms report milliseconds since the epoch (ios/LocationUtils.swift multiplies the
// CLLocation interval by 1000, Android passes location.time), so `at` is a plain Date away.
test('getFix maps a native reading onto the wire shape', async () => {
  setNext(async () => ({
    coords: {latitude: 13.7563, longitude: 100.5018, accuracy: 4.5},
    timestamp: 1700000000000,
    mocked: true,
  }));
  assert.deepEqual(await getFix(), {
    lat: 13.7563,
    lng: 100.5018,
    accuracy: 4.5,
    at: '2023-11-14T22:13:20.000Z',
    mocked: true,
  });
});

// A null accuracy (platform reports no uncertainty radius) and an absent mocked flag (iOS) must
// fall back to values the server refuses or distrusts, never to ones that read as precise/clean.
test('getFix falls back when the platform omits accuracy and mocked', async () => {
  setNext(async () => ({
    coords: {latitude: 13.7563, longitude: 100.5018, accuracy: null},
    timestamp: 1700000000000,
  }));
  const fix = await getFix();
  assert.equal(fix.accuracy, 9999);
  assert.equal(fix.mocked, false);
});

const NATIVE_DETAIL = 'kCLErrorDomain SECRET';

test('a native failure becomes LOCATION_UNAVAILABLE with no native detail in the message', async () => {
  const native = new Error(NATIVE_DETAIL);
  setNext(async () => {
    throw native;
  });
  const e = await getFix().then(
    () => assert.fail('expected getFix to reject'),
    (err) => err,
  );
  assert.ok(e instanceof LocationError, `expected a LocationError, got ${e.name}`);
  assert.equal(e.code, 'LOCATION_UNAVAILABLE');
  assert.ok(!e.message.includes('SECRET'), `leaked native detail: ${e.message}`);
  // The guarantee above is about message, the only part rendered to the user; cause keeps the
  // native error reachable for logs, since this path is otherwise unverifiable off-device.
  assert.equal(e.cause, native);
});
