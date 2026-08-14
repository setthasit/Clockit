// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts module under test.
//
// Every assertion here is invisible on a device and fails as a permanent spinner: the gate in
// app/_layout.tsx renders nothing until `hydrated` flips, so a rehydration path that never calls
// back bricks the launch with no error and no Retry. The two failure paths (corrupt JSON, a
// storage backend that rejects) cannot be provoked by hand at all.
//
// The real zustand and the real stores/ui.ts are driven — only AsyncStorage is stubbed. A
// hand-rolled fake store would agree with whatever we assumed persist does and pin nothing; what
// is actually being pinned is zustand's behaviour (onRehydrateStorage fires on the error path too).
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const ASYNC_STORAGE_STUB = 'stub:async-storage';

// ui.ts imports AsyncStorage, which pulls in react-native, which bare Node cannot parse. The stub
// is the whole contract createJSONStorage needs: three async methods over a Map. What stays
// unverified here is the real backend — its size limits, and whether it survives a killed app.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@react-native-async-storage/async-storage') {
      return {url: ASYNC_STORAGE_STUB, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== ASYNC_STORAGE_STUB) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export const items = new Map();
        let rejecting = false;
        export function setRejecting(v) { rejecting = v; }
        export default {
          getItem: async (k) => {
            if (rejecting) throw new Error('AsyncStorage unavailable');
            return items.get(k) ?? null;
          },
          setItem: async (k, v) => { items.set(k, v); },
          removeItem: async (k) => { items.delete(k); },
        };
      `,
    };
  },
});

const {items, setRejecting} = await import(ASYNC_STORAGE_STUB);

const KEY = 'clockit-ui';

// Enough turns for persist's getItem -> merge -> onRehydrateStorage chain, which is three promise
// hops deep. Real timers, so a hang shows up as a failed assertion rather than a hung suite.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

// One cold launch. The query string is what makes it *cold*: Node caches ESM by URL, so each tag
// builds a fresh store over the storage the caller just seeded.
//
// The pre-hydration window cannot be sampled from out here — awaiting the import already drains
// the microtask queue rehydration runs on — so the "starts false" half of each case is asserted
// against getInitialState(), which persist pins to the store's own initialiser.
async function launch(tag, seed) {
  items.clear();
  if (seed !== undefined) items.set(KEY, seed);
  const {useUiStore} = await import(new URL(`./ui.ts?${tag}`, import.meta.url).href);
  await settle();
  return {state: useUiStore.getState(), store: useUiStore};
}

const first = await launch('first-ever');
const corrupt = await launch('corrupt', '{"state":{"locationExplainerSeen"');

setRejecting(true);
const unreadable = await launch('unreadable');
setRejecting(false);

test('a first-ever launch starts unhydrated and finishes hydrated', () => {
  // Starting false is the point: the gate holds its spinner over the async rehydration window
  // instead of flashing the explainer at someone who dismissed it long ago.
  assert.equal(first.store.getInitialState().hydrated, false);
  assert.equal(first.state.hydrated, true, 'rehydration callback never fired on an empty store');
  assert.equal(first.state.locationExplainerSeen, false);
});

test('corrupt stored JSON lands on the defaults instead of hanging', () => {
  assert.equal(corrupt.state.hydrated, true, 'a parse failure left the gate spinning forever');
  assert.equal(corrupt.state.locationExplainerSeen, false);
});

test('a storage backend that rejects still hydrates', () => {
  assert.equal(unreadable.state.hydrated, true, 'a read failure left the gate spinning forever');
  assert.equal(unreadable.state.locationExplainerSeen, false);
});

test('hydrated is never persisted, so every launch starts false', async () => {
  first.store.getState().markLocationExplainerSeen();
  await settle();
  assert.deepEqual(JSON.parse(items.get(KEY)).state, {
    locationExplainerSeen: true,
    backgroundPromptSeen: false,
  });

  // The same storage, a new launch: the flag the user set comes back, the hydration bit does not.
  const relaunch = await launch('relaunch', items.get(KEY));
  assert.equal(relaunch.store.getInitialState().hydrated, false);
  assert.equal(relaunch.state.hydrated, true);
  assert.equal(relaunch.state.locationExplainerSeen, true);
});

// The store has no `version`/`migrate`, so this is what carries a phone upgrading across a
// schema change: a blob written before a field existed must land on that field's default rather
// than on undefined, which reads as "already asked" nowhere but would if a flag were inverted.
test('a blob written before a flag existed keeps the flag on its default', async () => {
  const old = await launch('phase-3-blob', '{"state":{"locationExplainerSeen":true},"version":0}');
  assert.equal(old.state.locationExplainerSeen, true);
  assert.equal(old.state.backgroundPromptSeen, false);
});
