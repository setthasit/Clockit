// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts module under test.
//
// Two things here are worth a test and the rest of the screen is not. The join is the only path by
// which a worker learns the server *refused* a shift they worked, and it fails silently when it is
// wrong — a record matched on the wrong key lights no icon and raises nothing. The grouping is what
// decides which day someone's hours are filed under. Both are pure, both are unreachable by hand
// (they need a dropped outbox item and a fetched window), and there is no renderer in this repo.
//
// Nothing is stubbed: lib/history.ts imports only types from api/entries and stores/outbox, which
// Node's type stripping removes outright, so the real lib/format.ts is the one being driven.
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

const {buildHistory} = await import('@/lib/history');

// Built from local Y/M/D parts, never from a literal 'Z' string: dayKey groups by local calendar
// day, so a hardcoded UTC instant would file these under a different day west of Greenwich and the
// grouping assertions would pass or fail by machine.
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();

function entry(overrides = {}) {
  const clockIn = overrides.in ?? at(2026, 8, 12, 9, 2);
  const clockOut = overrides.out === undefined ? at(2026, 8, 12, 17, 35) : overrides.out;
  return {
    id: overrides.id ?? 'e1',
    client_id: overrides.client_id ?? 'c1',
    employer_id: overrides.employer_id ?? null,
    status: clockOut ? 'closed' : 'open',
    clock_in: {at: clockIn, loc: {lat: 0, lng: 0}, accuracy: 5, mocked: false},
    clock_out: clockOut ? {at: clockOut, loc: {lat: 0, lng: 0}, accuracy: 5, mocked: false} : null,
    location_verified: true,
    flags: overrides.flags ?? [],
    created_at: clockIn,
  };
}

function attention(overrides = {}) {
  return {
    kind: overrides.kind ?? 'clock-out',
    clientId: overrides.clientId ?? 'a1',
    entryClientId: overrides.entryClientId ?? null,
    code: overrides.code ?? 'NO_OPEN_ENTRY',
    message: overrides.message ?? "You're not on shift.",
  };
}

const rows = (h) => h.sections.flatMap((s) => s.data);

test('a rejected clock-out lights the entry it closed, not its own key', () => {
  // The whole point: the close carries its own clientId ('close-key') and the *entry's* client_id.
  // A join on clientId finds nothing here, which is what silence would look like.
  const e = entry({client_id: 'entry-key'});
  const dropped = attention({
    kind: 'clock-out',
    clientId: 'close-key',
    entryClientId: 'entry-key',
  });

  const h = buildHistory([e], null, [dropped]);

  assert.deepEqual(h.unmatched, []);
  assert.equal(rows(h).length, 1);
  assert.deepEqual(rows(h)[0].attention, [dropped]);
});

test('a rejected clock-in lights its own entry, which is keyed by the same id', () => {
  const e = entry({client_id: 'in-key'});
  const dropped = attention({kind: 'clock-in', clientId: 'in-key', entryClientId: 'in-key'});

  const h = buildHistory([e], null, [dropped]);

  assert.deepEqual(rows(h)[0].attention, [dropped]);
  assert.deepEqual(h.unmatched, []);
});

test('a record naming an entry that never existed is surfaced, not swallowed', () => {
  // The cascade stores/outbox.ts documents: the clock-in was dropped, so no entry was ever
  // created, so its clock-out is answered NO_OPEN_ENTRY and dropped in turn with nothing to join.
  const orphan = attention({entryClientId: 'never-created'});
  const pings = attention({kind: 'pings', clientId: 'p1', entryClientId: null});

  const h = buildHistory([entry({client_id: 'unrelated'})], null, [orphan, pings]);

  assert.deepEqual(h.unmatched, [orphan, pings]);
  assert.deepEqual(rows(h)[0].attention, []);
});

test('every record lands exactly once, joined or unmatched', () => {
  const joined = attention({clientId: 'a1', entryClientId: 'c1'});
  const orphan = attention({clientId: 'a2', entryClientId: 'gone'});
  const pings = attention({kind: 'pings', clientId: 'a3', entryClientId: null});

  const h = buildHistory([entry({client_id: 'c1'})], null, [joined, orphan, pings]);

  const seen = [...rows(h).flatMap((r) => r.attention), ...h.unmatched].map((a) => a.clientId);
  assert.deepEqual(seen.sort(), ['a1', 'a2', 'a3']);
});

test('two records for one entry both reach the row', () => {
  const first = attention({clientId: 'a1', entryClientId: 'c1'});
  const second = attention({clientId: 'a2', entryClientId: 'c1'});

  const h = buildHistory([entry({client_id: 'c1'})], null, [first, second]);

  assert.deepEqual(rows(h)[0].attention, [first, second]);
});

test('groups by local calendar day, newest day and newest shift first', () => {
  const older = entry({
    client_id: 'older',
    in: at(2026, 8, 11, 9, 0),
    out: at(2026, 8, 11, 17, 0),
  });
  const morning = entry({
    client_id: 'morning',
    in: at(2026, 8, 12, 6, 0),
    out: at(2026, 8, 12, 10, 0),
  });
  const evening = entry({
    client_id: 'evening',
    in: at(2026, 8, 12, 18, 0),
    out: at(2026, 8, 12, 22, 0),
  });

  const h = buildHistory([morning, older, evening], null, []);

  assert.deepEqual(
    h.sections.map((s) => s.key),
    ['2026-08-12', '2026-08-11'],
  );
  assert.deepEqual(
    h.sections[0].data.map((r) => r.entry.client_id),
    ['evening', 'morning'],
  );
  assert.deepEqual(
    h.sections[1].data.map((r) => r.entry.client_id),
    ['older'],
  );
});

test('a late-evening shift is filed under the day it was worked', () => {
  // 23:30 local. Grouping on the UTC date instead would push this to tomorrow for anyone east of
  // Greenwich — the case lib/format.ts's dayKey exists for.
  const h = buildHistory([entry({in: at(2026, 8, 12, 23, 30), out: null})], null, []);
  assert.equal(h.sections[0].key, '2026-08-12');
});

test('day titles are relative for today and yesterday only', () => {
  const now = new Date(2026, 7, 12, 15, 0);
  const today = entry({client_id: 'today', in: at(2026, 8, 12, 9, 0), out: at(2026, 8, 12, 10, 0)});
  const yesterday = entry({
    client_id: 'yesterday',
    in: at(2026, 8, 11, 9, 0),
    out: at(2026, 8, 11, 10, 0),
  });
  const older = entry({client_id: 'older', in: at(2026, 8, 3, 9, 0), out: at(2026, 8, 3, 10, 0)});

  const h = buildHistory([today, yesterday, older], null, [], now);

  assert.deepEqual(
    h.sections.map((s) => s.title).slice(0, 2),
    ['Today', 'Yesterday'],
  );
  // The third is a formatted date, whose exact shape is the device locale's business — only that
  // it is neither of the relative labels, and not the raw key.
  assert.notEqual(h.sections[2].title, 'Yesterday');
  assert.notEqual(h.sections[2].title, '2026-08-03');
});

test('titles cross a month boundary without saying Yesterday twice', () => {
  const now = new Date(2026, 8, 1, 8, 0);
  const first = entry({client_id: 'first', in: at(2026, 9, 1, 7, 0), out: at(2026, 9, 1, 8, 0)});
  const last = entry({client_id: 'last', in: at(2026, 8, 31, 7, 0), out: at(2026, 8, 31, 8, 0)});

  const h = buildHistory([first, last], null, [], now);

  assert.deepEqual(
    h.sections.map((s) => s.title),
    ['Today', 'Yesterday'],
  );
});

test('an optimistic open entry the server has never seen still gets a row', () => {
  // clockFlow.localEntry: id '' while the clock-in waits in the outbox. Without this the running
  // shift is invisible on the one screen that explains why it has not synced.
  const optimistic = entry({id: '', client_id: 'pending', in: at(2026, 8, 12, 9, 0), out: null});

  const h = buildHistory([], optimistic, []);

  assert.equal(rows(h).length, 1);
  assert.equal(rows(h)[0].entry.client_id, 'pending');
});

test('the open entry is not duplicated once the server returns it', () => {
  const fromServer = entry({id: 'e9', client_id: 'same', in: at(2026, 8, 12, 9, 0), out: null});
  const optimistic = entry({id: '', client_id: 'same', in: at(2026, 8, 12, 9, 0), out: null});

  const h = buildHistory([fromServer], optimistic, []);

  assert.equal(rows(h).length, 1);
  // The server's copy wins: it is the one carrying a real id and a judged location_verified.
  assert.equal(rows(h)[0].entry.id, 'e9');
});

test('an empty window is empty sections, not a throw', () => {
  assert.deepEqual(buildHistory([], null, []), {sections: [], unmatched: []});
});
