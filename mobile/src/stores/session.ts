import Auth0, {CredentialsManagerError, CredentialsManagerErrorCodes} from 'react-native-auth0';
import {create} from 'zustand';

import {ApiError, setApiAuth} from '@/api/client';
import {getMe, type Me, type Profile} from '@/api/me';

// Also spread into <Auth0Provider> in app/_layout.tsx. Sharing one object is not just DRY:
// Auth0ClientFactory caches clients in a static Map keyed by a signature over
// {domain, clientId, useDPoP, timeout, maxRetries, localAuthenticationOptions,
// credentialsManagerStorageKey} (core/utils/configSignature.ts), so identical options make the
// provider's `new Auth0()` and ours below resolve to the *same* client instance. Diverging on any
// of those keys would silently split them into two clients.
//
// useDPoP defaults to true in v5 (NativeAuth0Client line 67), which binds tokens to a device key
// pair. backend/internal/auth/jwt.go only accepts `Authorization: Bearer <RS256 JWT>` and ignores
// the `cnf` claim, so proof-of-possession buys nothing while adding DPOP_KEY_MISSING /
// DPOP_KEY_MISMATCH as new ways to lose a session. Turn it on when the backend verifies DPoP proofs.
export const auth0Config = {
  domain: process.env.EXPO_PUBLIC_AUTH0_DOMAIN ?? '',
  clientId: process.env.EXPO_PUBLIC_AUTH0_CLIENT_ID ?? '',
  useDPoP: false,
};

// Lazy: the Auth0 constructor validates domain/clientId synchronously (core/utils/validation.ts),
// so building it at module scope would turn a missing env var into a crash while this module is
// imported — before any error UI exists.
let client: Auth0 | undefined;
function credentialsManager() {
  client ??= new Auth0(auth0Config);
  return client.credentialsManager;
}

// Refreshing needs a refresh token, so task 2.2's authorize() must request `offline_access`;
// without it every expired access token surfaces here as NO_REFRESH_TOKEN and signs the user out.
// It must equally pass `audience: EXPO_PUBLIC_AUTH0_AUDIENCE`: backend/internal/auth/jwt.go:42
// verifies with jwt.WithAudience(cfg.Auth0Audience), and with no audience requested Auth0 issues an
// opaque token instead of an RS256 JWT — every request then 401s and onUnauthorized fires in a loop.
const RETRYABLE: ReadonlySet<string> = new Set([
  CredentialsManagerErrorCodes.NO_NETWORK,
  CredentialsManagerErrorCodes.API_ERROR,
]);

// An offline iOS renew never reaches the set above. Auth0.swift 2.24.1 has no `noNetwork` case, so
// it fails as CredentialsManagerError(.renewFailed, cause: AuthenticationError)
// (CredentialsManager.swift:909) and NativeBridge.swift:752 forwards the *cause's* code rather than
// "RENEW_FAILED". A failure with no parseable API response is built by Auth0APIError.init(cause:),
// which sets code = "a0.sdk.internal_error.plain" (Auth0Error.swift:3-5, alongside .unknown and
// .empty); a rate-limited renew keeps its raw "too_many_requests". ERROR_CODE_MAP knows no a0.* or
// 429 key, so both collapse to UNKNOWN_ERROR — which would sign out an offline user and let the
// task 5.2 outbox discard their queued clock-in. Android already maps these to NO_NETWORK/API_ERROR
// (SecureCredentialsManager), and Auth0APIError.isRetryable likewise counts network failures and
// 429 as retryable, so matching on the raw code just restores that split on iOS. `code` survives
// the mapping because CredentialsManagerError extends AuthError, which assigns it verbatim.
// Auth0 5xx needs no entry here: with a JSON body it arrives as `server_error` (already API_ERROR),
// without one as a0.sdk.internal_error.*.
function isRetryableIosCode(code: string): boolean {
  return code.startsWith('a0.sdk.internal_error.') || code === 'too_many_requests';
}

/**
 * The single token source for api(). Works outside React (the task 9.1 outbox flushes from
 * NetInfo/AppState callbacks) because the credentials manager is native-backed, not hook-backed.
 *
 * getCredentials() silently refreshes an expired access token. Classification follows the
 * setApiAuth contract in api/client.ts: a transport failure must stay retryable, since signing out
 * an offline user strands them at a sign-in screen they cannot complete and makes the outbox
 * discard queued clock-ins. Anything else means the session cannot be recovered without a new login.
 */
export async function getAccessToken(): Promise<string> {
  let accessToken: string;
  try {
    // minTtl (2nd arg of getCredentials(scope?, minTtl?, parameters?, forceRefresh?)) defaults to
    // 0, which returns a token with one second of life as valid; expiring in flight would 401 and
    // sign out a session that only needed renewing. 60s is far below any access-token lifetime, so
    // LARGE_MIN_TTL is unreachable.
    ({accessToken} = await credentialsManager().getCredentials(undefined, 60));
  } catch (e) {
    // `e` is never logged or interpolated into a message: it can carry token and session detail.
    if (
      e instanceof CredentialsManagerError &&
      (RETRYABLE.has(e.type) || isRetryableIosCode(e.code))
    ) {
      throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.');
    }
    // Deliberately not an ApiError — that is the only signal that reaches onUnauthorized().
    // Unrecognised types land here too: failing closed costs a sign-in, failing open loops forever.
    throw new Error('Session cannot be renewed.');
  }
  useSessionStore.getState().setToken(accessToken);
  return accessToken;
}

type SessionState = {
  accessToken: string | null;
  me: Me | null;
  setToken(t: string | null): void;
  loadMe(): Promise<void>;
  /** The answer to PATCH /v1/me (task 8.1). Memberships are untouched — that route never returns
   * them, and refetching the envelope to learn what the response already said would cost a
   * request. */
  setProfile(p: Profile): void;
  clear(): void;
};

// Not persisted: tokens live in the native keychain/SharedPreferences the credentials manager owns,
// and `me` is cheap to refetch on launch. Persisting either would create a second copy to invalidate.
export const useSessionStore = create<SessionState>((set) => ({
  accessToken: null,
  me: null,

  setToken: (accessToken) => set({accessToken}),

  // Rejects rather than swallowing, and never clears the session on failure: this runs at launch,
  // where an offline phone is not a signed-out user. api() only ever throws ApiError, and its 401
  // path already routes to clear() via onUnauthorized, so the caller can show retry against a
  // still-valid session. Callers hold their own error state — a `meError` field here would only
  // duplicate what the one screen that calls this already needs locally.
  loadMe: async () => set({me: await getMe()}),

  // Guarded rather than a plain set, and the guard is the reason this lives here instead of the
  // one screen that calls it: onUnauthorized() (or a sign-out) can clear the session while a save
  // is in flight, and writing an envelope from here would put a signed-in user with no memberships
  // back on screen — past the gate, with the clock tab offering only a personal shift.
  setProfile: (user) => set((s) => (s.me ? {me: {...s.me, user}} : s)),

  // Local state only. Signing out of Auth0 (clearSession/clearCredentials) is task 8.1's job —
  // do not add it here, or 8.1 ends up clearing credentials twice.
  clear: () => set({accessToken: null, me: null}),
}));

// Module scope, not a useEffect: api() can be called by non-React code (outbox) and by screens that
// mount in the same tick as the provider. An unregistered handler sends unauthenticated requests
// that 401 with a no-op onUnauthorized, leaving the user on a spinner forever. Importing this module
// is enough to arm it, and app/_layout.tsx imports auth0Config from here before rendering anything.
setApiAuth({
  getToken: getAccessToken,
  onUnauthorized: () => useSessionStore.getState().clear(),
});
