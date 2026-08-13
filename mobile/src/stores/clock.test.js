// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts module under test.
//
// Two behaviours here are invisible until they cost someone their hours: picking the open entry out
// of a full history, and refusing to overwrite optimistic state with a server answer that is
// already stale. Both fail silently on a device — the screen just says "clocked out" — and the
// second needs a request in flight across an offline tap, which cannot be staged by hand.
//
// The real zustand and the real stores/clock.ts are driven; only listEntries is stubbed.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const ENTRIES_STUB = 'stub:api-entries';

// api/entries.ts reaches api/client.ts and the fetch/env surface behind it; the stub is the whole
// contract clock.ts uses. What stays unverified here is the wire format itself — that the server
// really returns `status` and `clock_in.at` in these shapes.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/api/entries') return {url: ENTRIES_STUB, shortCircuit: true};
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== ENTRIES_STUB) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        let impl = async () => [];
        export function setListEntries(fn) { impl = fn; }
        export const listEntries = (...args) => impl(...args);
      `,
    };
  },
});

const {setListEntries} = await import(ENTRIES_STUB);
const {useClockStore} = await import('@/stores/clock');

const point = (at) => ({at, loc: {lat: 49.28, lng: -123.12}, accuracy: 8, mocked: false});

const entry = (id, status, at) => ({
  id,
  client_id: `c-${id}`,
  employer_id: null,
  status,
  clock_in: point(at),
  clock_out: status === 'closed' ? point(at) : null,
  location_verified: true,
  flags: [],
  created_at: at,
});

const clock = () => useClockStore.getState();

function reset() {
  useClockStore.setState({openEntry: null, pendingSince: null});
  setListEntries(async () => []);
}

test('finds the open entry in a full history, whatever its age', async () => {
  reset();
  // Newest first, as the server sorts. The open one started six weeks ago and was never closed:
  // a "today" window would return only the first two and report the worker as clocked out.
  const forgotten = entry('old', 'open', '2026-01-02T23:30:00Z');
  setListEntries(async () => [
    entry('b', 'closed', '2026-02-13T09:00:00Z'),
    entry('a', 'closed', '2026-02-12T09:00:00Z'),
    forgotten,
  ]);

  await clock().hydrateFromServer();
  assert.equal(clock().openEntry, forgotten);
});

test('hydrating with no open entry clocks the user out', async () => {
  reset();
  useClockStore.setState({openEntry: entry('stale', 'open', '2026-02-13T09:00:00Z')});
  // Clocked out on another device (phase 5 stops the ping task off the back of this).
  setListEntries(async () => [entry('b', 'closed', '2026-02-13T09:00:00Z')]);

  await clock().hydrateFromServer();
  assert.equal(clock().openEntry, null);
});

test('two open entries resolve to the newest, compared as instants', async () => {
  reset();
  // Impossible against the real server (unique partial index), so the point is only that the
  // tie-break is deliberate. The half-second gap is the trap: Go trims trailing zeros, so
  // "…:00Z" > "…:00.5Z" as strings while being the earlier instant.
  const later = entry('later', 'open', '2026-02-13T09:00:00.5Z');
  setListEntries(async () => [entry('earlier', 'open', '2026-02-13T09:00:00Z'), later]);

  await clock().hydrateFromServer();
  assert.equal(clock().openEntry, later);
});

test('a failed hydrate rejects and leaves the open entry standing', async () => {
  reset();
  const onShift = entry('live', 'open', '2026-02-13T09:00:00Z');
  useClockStore.setState({openEntry: onShift});
  setListEntries(async () => {
    throw new Error('offline');
  });

  await assert.rejects(clock().hydrateFromServer(), /offline/);
  assert.equal(clock().openEntry, onShift, 'an offline hydrate wiped a live shift');
});

test('an offline tap mid-flight is not overwritten by the stale server answer', async () => {
  reset();
  let respond;
  setListEntries(() => new Promise((resolve) => (respond = () => resolve([]))));

  const hydrating = clock().hydrateFromServer();
  // The tap lands while the request is in flight: from here the server's "no open entry" is a
  // view of a world that has not seen the queued clock-in yet.
  const optimistic = entry('queued', 'open', '2026-02-13T09:00:00Z');
  clock().setPending(optimistic);
  respond();
  await hydrating;

  assert.equal(clock().openEntry, optimistic, 'hydrate clocked out a worker with a queued shift');
  assert.notEqual(clock().pendingSince, null);
});

test('setOpen clears pendingSince, which re-arms hydrate', async () => {
  reset();
  clock().setPending(entry('queued', 'open', '2026-02-13T09:00:00Z'));
  assert.notEqual(clock().pendingSince, null);

  // What the outbox does once the item is accepted or dropped (9.1).
  clock().setOpen(null);
  assert.equal(clock().pendingSince, null);

  const server = entry('server', 'open', '2026-02-13T09:05:00Z');
  setListEntries(async () => [server]);
  await clock().hydrateFromServer();
  assert.equal(clock().openEntry, server);
});
