// Run with `npm test` (node --test — no jest, no devDependencies). Same shape as history.test.js:
// this file is .js so it needs no @types/node to keep tsc green, and Node strips the types off the
// .ts module under test.
//
// What is worth a test here is the badge, and it is worth one because it is the only place in the
// app that turns `location_verified` into a sentence — and that field means three different things
// depending on the entry (backend store.go:173 sets it true on every clock-in, personal or not).
// Getting it wrong prints either a green tick for a check that never ran or an accusation about a
// worker's whereabouts, and both look perfectly fine in a screenshot. findEntry is here for its
// empty-id guard, which is what stops an unsent optimistic entry from being rendered as a record.
// The screen's layout, spinners and pressed states are not tested: there is no renderer in this
// repo, and they are reachable by looking at them.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
});

const {assignError, findEntry, flagNotes, locationBadge} = await import('@/lib/entryDetail');

function entry(overrides = {}) {
  const closed = overrides.closed ?? true;
  return {
    id: overrides.id ?? 'e1',
    client_id: overrides.client_id ?? 'c1',
    employer_id: overrides.employer_id ?? null,
    status: closed ? 'closed' : 'open',
    clock_in: {at: '2026-08-12T09:00:00Z', loc: {lat: 0, lng: 0}, accuracy: 5, mocked: false},
    clock_out: closed
      ? {at: '2026-08-12T17:00:00Z', loc: {lat: 0, lng: 0}, accuracy: 5, mocked: false}
      : null,
    location_verified: overrides.location_verified ?? true,
    flags: overrides.flags ?? [],
    created_at: '2026-08-12T09:00:00Z',
  };
}

test('a personal entry claims neither verified nor unverified', () => {
  // The case the server makes easy to get wrong: location_verified is *true* on this entry and
  // means nothing, because a personal clock-in is its own anchor.
  const badge = locationBadge(entry({employer_id: null, location_verified: true}), null);

  assert.equal(badge.tone, 'muted');
  assert.doesNotMatch(badge.label, /verified/i);
  assert.match(badge.detail, /no employer zone/i);
});

test('an employer entry with a verified location says both fixes passed', () => {
  const badge = locationBadge(entry({employer_id: 'emp1', location_verified: true}), 'Acme');

  assert.equal(badge.tone, 'ok');
  assert.equal(badge.label, 'Location verified');
  assert.match(badge.detail, /Clock-in and clock-out were both inside Acme's zone\./);
});

test('an open employer entry only claims the clock-in', () => {
  const badge = locationBadge(
    entry({employer_id: 'emp1', location_verified: true, closed: false}),
    'Acme',
  );

  assert.equal(badge.detail, "Clock-in was inside Acme's zone.");
});

test('an unverified entry names the zone, both fixes, and that the shift still counts', () => {
  const badge = locationBadge(entry({employer_id: 'emp1', location_verified: false}), 'Acme');

  assert.equal(badge.tone, 'warn');
  assert.equal(badge.label, 'Location not verified');
  // "or", not "at clock-in time": the server re-checks both fixes and never reports which missed.
  assert.match(badge.detail, /Clock-in or clock-out was outside Acme's zone/);
  assert.match(badge.detail, /still recorded/);
});

test('a revoked membership still produces a readable sentence', () => {
  const badge = locationBadge(entry({employer_id: 'emp1', location_verified: false}), null);

  assert.match(badge.detail, /outside your employer's zone/);
  assert.doesNotMatch(badge.detail, /null|undefined/);
});

test('flag notes are listed in a fixed order, never the wire order', () => {
  const notes = flagNotes(['speed_anomaly', 'backdated']);

  assert.deepEqual(
    notes.map((n) => n.title),
    ['Recorded offline', 'Unusual movement'],
  );
});

test('an unknown flag renders nothing rather than raw jargon', () => {
  assert.deepEqual(flagNotes(['some_future_flag']), []);
  assert.deepEqual(flagNotes([]), []);
});

test('assign refusals are rewritten only where the server copy is unshowable', () => {
  assert.equal(
    assignError('NOT_MEMBER', 'not a member of this employer', 'Acme'),
    "You're no longer a member of Acme.",
  );
  assert.match(assignError('INVALID_ARGUMENT', 'entry already has an employer', 'Acme'), /refresh/i);
  // The fall-through is the decision worth pinning: client.ts's offline copy is already written
  // for this audience and must not be replaced by a map entry.
  assert.equal(
    assignError('NETWORK', 'Could not reach the server. Check your connection.', 'Acme'),
    'Could not reach the server. Check your connection.',
  );
});

test('findEntry falls back to an open entry outside the fetched window', () => {
  const open = entry({id: 'old', closed: false});

  assert.equal(findEntry([], open, 'old'), open);
  assert.equal(findEntry([entry({id: 'e1'})], open, 'e1').id, 'e1');
  assert.equal(findEntry([entry({id: 'e1'})], open, 'missing'), null);
});

test('an unsent optimistic entry is never resolved by an empty id', () => {
  // clockFlow.localEntry writes id: '' on purpose, so this pairing is the real one.
  const optimistic = entry({id: '', closed: false});

  assert.equal(findEntry([], optimistic, ''), null);
});
