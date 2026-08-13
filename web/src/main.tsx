import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router/dom';
import {Auth0Provider, type AppState} from '@auth0/auth0-react';
import {Theme} from '@astryxdesign/core/theme';
import {router} from './router';
import {clockitTheme} from './clockit';
import './index.css';
import './clockit.css';

// The SDK's default callback does history.replaceState(appState.returnTo), which moves the
// address bar without telling react-router: the data router still believes it is at '/',
// renders the index route, and that route's <Navigate to="/calendar"/> overwrites the deep
// link a tick later. Navigating through the router keeps URL and router state in one place,
// so the returnTo survives. router.navigate() outside React is what a data router supports,
// and createBrowserRouter ran .initialize() at module evaluation, long before this fires.
// Safe because no route has a loader/middleware/lazy: navigate() commits the location
// synchronously. Add one and this becomes a race with the index route's <Navigate/>.
// Replacing also drops ?code=/?state= from the URL, which the replaceState was doing as a
// side effect and which must keep happening: a reload with them still present re-enters
// handleRedirectCallback with no live transaction and fails with "Invalid state".
function onRedirectCallback(appState?: AppState) {
  // No appState (a login that carried no returnTo): pathname only — never the current
  // search, which is still the callback's own ?code=&state=.
  void router.navigate(appState?.returnTo ?? window.location.pathname, {replace: true});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* cacheLocation="memory" keeps tokens out of localStorage, where XSS could read
        them — but the SDK then holds the refresh token in a Web Worker with no
        persistent storage (useRefreshTokensFallback defaults to false), and the worker
        dies with the page. So after every reload, new tab or deep link checkSession()
        cannot mint a token, isAuthenticated is false, and the user lands on /sign-in;
        the click round-trips silently through the Auth0 SSO cookie — no password, but
        the screen still flashes. Accepted: the plan mandates memory.
        ponytail: useRefreshTokensFallback removes the bounce, but the iframe it falls
        back to needs an Auth0 custom domain to survive third-party-cookie blocking. */}
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      }}
      cacheLocation="memory"
      useRefreshTokens
      onRedirectCallback={onRedirectCallback}>
      <Theme theme={clockitTheme} mode="system">
        <RouterProvider router={router} />
      </Theme>
    </Auth0Provider>
  </StrictMode>,
);
