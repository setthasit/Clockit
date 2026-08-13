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
// Node cannot parse. getFix() needs a device and is not tested here, so the specifier is
// redirected to a stub — no test below reaches the native module.
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
    return {format: 'module', shortCircuit: true, source: 'export const Accuracy = {};'};
  },
});

const {distanceM, inRange} = await import('@/location/fix');

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
