import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {RouterProvider} from 'react-router/dom';
import {Theme} from '@astryxdesign/core/theme';
import {router} from './router';
import {clockitTheme} from './clockit';
import './index.css';
import './clockit.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={clockitTheme} mode="system">
      <RouterProvider router={router} />
    </Theme>
  </StrictMode>,
);
