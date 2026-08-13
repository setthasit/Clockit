// A failed login (bad audience, missing grant) comes back to '/' as ?error=&state= and
// leaves the guard unauthenticated, so those params would ride into returnTo and be put
// back in the address bar after the *next*, successful login. A reload there hits the SDK's
// hasAuthParams() — (code|connect_code|error) && state — with no live transaction and shows
// an "Invalid state" banner over a perfectly good session. Nothing this app links to uses
// these names.
// False negatives are impossible: hasAuthParams() only fires when its
// STATE_RE = /[?&]state=[^&]+/ matches, and anything matching that matches the `state`
// branch here — which is why connect_code is covered without being named.
// The [?&] anchor is load-bearing in the other direction: without it this would also eat
// ?filter=state, ?name=error and every other param whose *value* happens to say so.
export const AUTH_PARAMS_RE = /[?&](code|state|error)=/;
