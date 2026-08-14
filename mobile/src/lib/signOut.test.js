// Run with `npm test` (node --test — no jest, no devDependencies). This file is .js so it needs
// no @types/node to keep tsc green; Node strips the types off the .ts modules under test.
//
// Sign-out is silent when it is wrong. Every failure below looks exactly like a working app:
// a cancelled logout that quietly destroyed a queued shift, a wipe that left the previous worker's
// clock-in on disk for the next person's account, a hydrate that landed after the wipe and put
// someone else's shift back on screen, or a flush gate that was never released and killed the
// queue for the process lifetime. None of them is reachable by hand — they need a cancelled
// browser dialog, a kill, or a request in flight across the wipe.
//
// The real zustand, the real persist, the real stores and the real shipped WebAuthError are
// driven; only AsyncStorage, the entries endpoints and Auth0's native client are stubbed. The
// error is built through the genuine class so the real ERROR_CODE_MAP computes `.type` — a
// hand-rolled fake would agree with whatever we assumed and prove nothing.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const auth0Model = (name) =>
  new URL(`../../node_modules/react-native-auth0/lib/module/core/models/${name}.js`, import.meta.url)
    .href;

const ASYNC_STORAGE_STUB = 'stub:async-storage';
const ENTRIES_STUB = 'stub:api-entries';
const AUTH0_STUB = 'stub:react-native-auth0';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@react-native-async-storage/async-storage') {
      return {url: ASYNC_STORAGE_STUB, shortCircuit: true};
    }
    if (specifier === 'react-native-auth0') return {url: AUTH0_STUB, shortCircuit: true};
    if (specifier === '@/api/entries') return {url: ENTRIES_STUB, shortCircuit: true};
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    // The package's build output is ESM with Metro-style extensionless relative imports.
    if (specifier.startsWith('./') && context.parentURL?.includes('react-native-auth0')) {
      return {url: new URL(`${specifier}.js`, context.parentURL).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === ASYNC_STORAGE_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const items = new Map();
          let gate = null;
          // Holds the launch read open. The rehydration window is otherwise already drained by the
          // time an \`await import()\` returns, and that window is where the flush gate can wedge.
          export function blockReads() {
            let release;
            gate = new Promise((r) => (release = r));
            return () => { gate = null; release(); };
          }
          export default {
            getItem: async (k) => {
              const v = items.get(k) ?? null;
              if (gate) await gate;
              return v;
            },
            setItem: async (k, v) => { items.set(k, v); },
            removeItem: async (k) => { items.delete(k); },
          };
        `,
      };
    }
    if (url === ENTRIES_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const MAX_PING_BATCH = 64;
          let list = async () => [];
          export function setListEntries(fn) { list = fn; }
          export const listEntries = (...a) => list(...a);
          export const clockIn = async () => ({});
          export const clockOut = async () => ({});
          export const postPings = async () => ({});
        `,
      };
    }
    if (url === AUTH0_STUB) {
      // Redirected rather than deep-imported in the test, so there is exactly one WebAuthError
      // class identity: signOut.ts's \`instanceof\` has to see the constructor we throw.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export {WebAuthError, WebAuthErrorCodes} from ${JSON.stringify(auth0Model('WebAuthError'))};
          export {CredentialsManagerError, CredentialsManagerErrorCodes} from ${JSON.stringify(auth0Model('CredentialsManagerError'))};
          export default class Auth0 { credentialsManager = {}; }
        `,
      };
    }
    return next(url, context);
  },
});

const KEY = 'clockit-outbox';
const AT = '2026-02-13T09:00:00Z';

const storage = await import(ASYNC_STORAGE_STUB);
const {setListEntries} = await import(ENTRIES_STUB);
const {AuthError} = await import(auth0Model('AuthError'));
const {WebAuthError} = await import(AUTH0_STUB);

// Seeded before the outbox module loads, and left blocked for the first test: that test is the
// launch race, and the window closes the moment this resolves.
storage.items.set(
  KEY,
  JSON.stringify({state: {items: [queuedClockIn('prev-1')], needsAttention: []}, version: 0}),
);
const releaseReads = storage.blockReads();

const {useOutboxStore} = await import('@/stores/outbox');
const {useClockStore} = await import('@/stores/clock');
const {useSessionStore} = await import('@/stores/session');
const {signOut, SIGN_OUT_FAILED} = await import('@/lib/signOut');

function queuedClockIn(id) {
  return {
    kind: 'clock-in',
    clientId: id,
    queuedAt: AT,
    body: {client_id: id, at: AT, loc: {lat: 49.28, lng: -123.12, accuracy: 8}, mocked: false},
  };
}

function openEntry(id) {
  return {
    id,
    client_id: `c-${id}`,
    employer_id: null,
    status: 'open',
    clock_in: {at: AT, loc: {lat: 49.28, lng: -123.12}, accuracy: 8, mocked: false},
    clock_out: null,
    location_verified: true,
    flags: [],
    created_at: AT,
  };
}

const ok = async () => {};
const rejects = (e) => async () => {
  throw e;
};

// The real class, built from the real code Auth0 forwards for a dismissed logout browser.
const cancelled = () =>
  new WebAuthError(
    new AuthError('a0.session.user_cancelled', 'User cancelled', {
      code: 'a0.session.user_cancelled',
    }),
  );

// Any non-cancel rejection. Offline is the one that matters: webAuth.clearSession has to load a
// logout URL, and a worker handing over a phone in a dead zone still has to be able to sign out.
const offline = () =>
  new WebAuthError(new AuthError('a0.network_error', 'Network error', {code: 'a0.network_error'}));

/** Puts a full previous-worker session on the device: a queued shift, an open shift, a profile. */
function seedSignedIn() {
  useOutboxStore.setState({
    items: [queuedClockIn('prev-1')],
    needsAttention: [{kind: 'clock-in', clientId: 'prev-0', entryClientId: 'prev-0', code: 'X', message: 'y'}],
  });
  useClockStore.setState({
    openEntry: openEntry('e1'),
    lastClosed: openEntry('e0'),
    pendingSince: AT,
  });
  useSessionStore.setState({
    accessToken: 'token',
    me: {user: {id: 'u1', email: 'a@b.c', name: 'Prev', has_phone: false}, memberships: []},
  });
  storage.items.set(KEY, 'anything');
}

function assertWiped() {
  assert.deepEqual(useOutboxStore.getState().items, []);
  assert.deepEqual(useOutboxStore.getState().needsAttention, []);
  assert.equal(useClockStore.getState().openEntry, null);
  assert.equal(useClockStore.getState().lastClosed, null);
  assert.equal(useClockStore.getState().pendingSince, null);
  assert.equal(useSessionStore.getState().me, null);
  assert.equal(useSessionStore.getState().accessToken, null);
}

// Enough turns for persist's own write to land after a set.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

// FIRST, and it has to be: the launch read is still blocked, which is the whole condition. A 401
// at launch routes straight to sign-out, so this is an ordinary sequence, not an exotic one.
// clearStorage() bumps persist's hydrationVersion and every `.then` in the in-flight hydrate bails
// on the mismatch — including the one that releases the flush gate. Open-code those two lines
// instead of calling clearForSignOut() and the queue is dead for the rest of the process, silently,
// with items piling up on disk and no error anywhere.
test('sign-out during the launch read leaves the queue able to flush', async () => {
  seedSignedIn();

  assert.deepEqual(await signOut({clearSession: ok, clearCredentials: ok}), {
    done: true,
    message: null,
  });

  // Raced rather than awaited: a wedged flush never settles, and a test that hangs is a test that
  // reports nothing.
  const outcome = await Promise.race([
    useOutboxStore
      .getState()
      .flush()
      .then(() => 'flushed'),
    new Promise((r) => setTimeout(() => r('wedged'), 500)),
  ]);
  assert.equal(outcome, 'flushed');

  releaseReads();
  await settle();
});

test('a successful sign-out clears every store and the queue on disk', async () => {
  seedSignedIn();

  assert.deepEqual(await signOut({clearSession: ok, clearCredentials: ok}), {
    done: true,
    message: null,
  });

  assertWiped();
  await settle();
  // Memory alone is not enough: the store's `merge` concatenates *stored* items in front of
  // memory, so a surviving blob resurrects the previous worker's clock-in on the next launch and
  // sends it under the new account.
  assert.equal(storage.items.has(KEY), false);
});

// The browser logout is the only step a worker can refuse, and refusing it must cost nothing —
// their queued hours are still theirs and they are still signed in. The SDK's own clearSession is
// webAuth.clearSession() -> credentialsManager.clearCredentials(), so a cancel rejects before the
// credentials are touched: wiping here would leave the app signed in with an empty queue.
test('a cancelled logout wipes nothing and touches no credentials', async () => {
  seedSignedIn();
  let clearedCredentials = false;

  assert.deepEqual(
    await signOut({
      clearSession: rejects(cancelled()),
      clearCredentials: async () => {
        clearedCredentials = true;
      },
    }),
    {done: false, message: null},
  );

  assert.equal(clearedCredentials, false);
  assert.equal(useOutboxStore.getState().items.length, 1);
  assert.equal(useOutboxStore.getState().needsAttention.length, 1);
  assert.notEqual(useClockStore.getState().openEntry, null);
  assert.notEqual(useSessionStore.getState().me, null);
  await settle();
  assert.equal(storage.items.has(KEY), true);
});

// Offline, or any other failure that is not the worker's own choice. Refusing to sign out would
// strand someone handing over a shared phone in a dead zone — the ordinary case in shift work.
test('a failed federated logout falls back to clearing credentials locally, then wipes', async () => {
  seedSignedIn();
  let clearedCredentials = false;

  assert.deepEqual(
    await signOut({
      clearSession: rejects(offline()),
      clearCredentials: async () => {
        clearedCredentials = true;
      },
    }),
    {done: true, message: null},
  );

  assert.equal(clearedCredentials, true);
  assertWiped();
});

// The invariant: nothing local is wiped unless the credentials are actually gone. Half a sign-out
// — an emptied queue behind a session that is still live — is the one state with no way back.
test('a sign-out that cannot clear credentials wipes nothing', async () => {
  seedSignedIn();

  assert.deepEqual(
    await signOut({
      clearSession: rejects(offline()),
      clearCredentials: rejects(new Error('keychain unavailable')),
    }),
    {done: false, message: SIGN_OUT_FAILED},
  );

  assert.equal(useOutboxStore.getState().items.length, 1);
  assert.notEqual(useClockStore.getState().openEntry, null);
  assert.notEqual(useSessionStore.getState().me, null);
});

// The clock store's reset() bumps a module-scope write generation, and this is what that is for:
// a hydrate issued with the previous worker's token is still in flight across the wipe, and its
// answer describes a world where they are still signed in. Land it and their open shift — and the
// coordinates on it — reappear on a screen that now belongs to someone else.
test('a hydrate in flight across the wipe cannot resurrect the previous shift', async () => {
  seedSignedIn();

  let deliver;
  setListEntries(() => new Promise((r) => (deliver = r)));
  const inFlight = useClockStore.getState().hydrateFromServer();

  await signOut({clearSession: ok, clearCredentials: ok});
  assert.equal(useClockStore.getState().openEntry, null);

  deliver([openEntry('e1')]);
  await inFlight;

  assert.equal(useClockStore.getState().openEntry, null);
  assert.equal(useClockStore.getState().lastClosed, null);
  setListEntries(async () => []);
});
