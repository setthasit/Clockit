import Auth0, {CredentialsManagerError, CredentialsManagerErrorCodes} from 'react-native-auth0';
import {create} from 'zustand';

import {ApiError, setApiAuth} from '@/api/client';
import {getMe, type Me} from '@/api/me';

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
const RETRYABLE: ReadonlySet<string> = new Set([
  CredentialsManagerErrorCodes.NO_NETWORK,
  CredentialsManagerErrorCodes.API_ERROR,
]);

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
    ({accessToken} = await credentialsManager().getCredentials());
  } catch (e) {
    // `e` is never logged or interpolated into a message: it can carry token and session detail.
    if (e instanceof CredentialsManagerError && RETRYABLE.has(e.type)) {
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
