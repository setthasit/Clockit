import {createBrowserRouter, Navigate} from 'react-router';
import {GuardedLayout} from './components/GuardedLayout';
import {Shell} from './components/AppShell';
import {SignInRoute} from './routes/sign-in';
import {OnboardingRoute} from './routes/onboarding';
import {CalendarRoute} from './routes/calendar';
import {TableRoute} from './routes/table';
import {EmployeesRoute} from './routes/employees';
import {SettingsRoute} from './routes/settings';

export const router = createBrowserRouter([
  {path: '/sign-in', element: <SignInRoute />},
  {
    element: <GuardedLayout />,
    children: [
      // Outside the Shell: a user with zero employers has nothing to switch between
      // and no nav destination that would load.
      {path: '/onboarding', element: <OnboardingRoute />},
      {
        element: <Shell />,
        children: [
          {index: true, element: <Navigate to="/calendar" replace />},
          {path: '/calendar', element: <CalendarRoute />},
          {path: '/table', element: <TableRoute />},
          {path: '/employees', element: <EmployeesRoute />},
          {path: '/settings', element: <SettingsRoute />},
          // Prod LB rewrites unknown paths to index.html, so typo'd deep links land here.
          {path: '*', element: <Navigate to="/calendar" replace />},
        ],
      },
    ],
  },
]);
