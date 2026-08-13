// Run with `npm test` (node --test — no jest, no devDependencies). Node strips the types off the
// .ts modules under test; this file itself is .js so it needs no @types/node to keep tsc green.
//
// Guards the one branch in session.ts that decides between "retry later" and "sign the user out".
// Getting it wrong is a data-loss path: a wrong sign-out strands an offline user at a Universal
// Login they cannot complete and makes the task 5.2 outbox discard their queued clock-ins.
//
// The inputs are fed through the *real* shipped CredentialsManagerError so the real ERROR_CODE_MAP
// computes `.type`. A hand-rolled fake would agree with whatever we assumed and prove nothing —
// the iOS a0.sdk.internal_error.plain case below is exactly what such a fake missed once.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const src = new URL('../', import.meta.url);
// The package's own build output, not its TypeScript sources: Node refuses to strip types under
// node_modules, and the build is what actually ships to the device anyway.
const auth0Model = (name) =>
  new URL(`../../node_modules/react-native-auth0/lib/module/core/models/${name}.js`, import.meta.url)
    .href;
const AUTH0_STUB = 'auth0-stub:react-native-auth0';

// react-native-auth0's entrypoint pulls in react-native, which bare Node cannot parse, so the
// specifier is redirected to a module that re-exports the genuine error classes and stubs only the
// native client. Redirecting (rather than deep-importing in the test) keeps one class identity, so
// session.ts's `instanceof CredentialsManagerError` still sees the same constructor we throw.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native-auth0') return {url: AUTH0_STUB, shortCircuit: true};
    if (specifier.startsWith('@/')) {
      return {url: new URL(`${specifier.slice(2)}.ts`, src).href, shortCircuit: true};
    }
    // That build is ESM with Metro-style extensionless relative imports, which Node will not resolve.
    if (specifier.startsWith('./') && context.parentURL?.includes('react-native-auth0')) {
      return {url: new URL(`${specifier}.js`, context.parentURL).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== AUTH0_STUB) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export {CredentialsManagerError, CredentialsManagerErrorCodes} from ${JSON.stringify(auth0Model('CredentialsManagerError'))};
        export let nextError;
        export function setNextError(e) { nextError = e; }
        export default class Auth0 {
          credentialsManager = {getCredentials: async () => { throw nextError; }};
        }
      `,
    };
  },
});

const {AuthError} = await import(auth0Model('AuthError'));
const {CredentialsManagerError, setNextError} = await import(AUTH0_STUB);
const {getAccessToken} = await import('@/stores/session');
const {ApiError} = await import('@/api/client');

// Seeded into every source error: nothing Auth0 hands us may reach a message we show a user.
const SECRET = 'refresh_token=SECRET';

// Drives the real getAccessToken() and returns whatever it rejected with.
async function thrownBy(code) {
  setNextError(
    new CredentialsManagerError(new AuthError('renewFailed', `renew failed ${SECRET}`, {code})),
  );
  return await getAccessToken().then(
    () => assert.fail(`expected ${code} to reject`),
    (e) => e,
  );
}

// Must stay signed in and retryable. The a0.sdk.internal_error.plain entry is the offline-iOS
// case: drop it and this suite goes green while offline users get signed out.
const RETRYABLE = [
  'NO_NETWORK',
  'API_ERROR',
  'a0.sdk.internal_error.plain',
  'a0.sdk.internal_error.unknown',
  'a0.sdk.internal_error.empty',
  'too_many_requests',
];

// Genuinely unrecoverable without a new login: must reach onUnauthorized(), which only a
// non-ApiError does (see the setApiAuth contract in api/client.ts).
const UNRECOVERABLE = ['NO_CREDENTIALS', 'NO_REFRESH_TOKEN', 'RENEW_FAILED', 'SESSION_EXPIRED'];

for (const code of RETRYABLE) {
  test(`${code} stays retryable`, async () => {
    const e = await thrownBy(code);
    assert.ok(e instanceof ApiError, `${code} must be an ApiError, got ${e.name}`);
    assert.equal(e.status, 0);
    assert.equal(e.code, 'NETWORK');
  });
}

for (const code of UNRECOVERABLE) {
  test(`${code} signs the user out`, async () => {
    const e = await thrownBy(code);
    assert.ok(!(e instanceof ApiError), `${code} must not be an ApiError`);
  });
}

test('no Auth0 detail leaks into the message shown to the user', async () => {
  for (const code of [...RETRYABLE, ...UNRECOVERABLE]) {
    const e = await thrownBy(code);
    assert.ok(!e.message.includes('SECRET'), `${code} leaked source error detail: ${e.message}`);
  }
});
