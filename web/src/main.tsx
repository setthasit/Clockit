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
    {/* Tokens live in memory only (never localStorage), so a refresh token is what
        survives a page reload. */}
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
