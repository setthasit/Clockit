import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router/dom';
import {Auth0Provider} from '@auth0/auth0-react';
import {Theme} from '@astryxdesign/core/theme';
import {router} from './router';
import {clockitTheme} from './clockit';
import './index.css';
import './clockit.css';

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
      useRefreshTokens>
      <Theme theme={clockitTheme} mode="system">
        <RouterProvider router={router} />
      </Theme>
    </Auth0Provider>
  </StrictMode>,
);
