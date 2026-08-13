import {createBrowserRouter, Navigate} from 'react-router';
import {GuardedLayout} from './components/GuardedLayout';
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
      {index: true, element: <Navigate to="/calendar" replace />},
      {path: '/onboarding', element: <OnboardingRoute />},
      {path: '/calendar', element: <CalendarRoute />},
      {path: '/table', element: <TableRoute />},
      {path: '/employees', element: <EmployeesRoute />},
      {path: '/settings', element: <SettingsRoute />},
    ],
  },
]);
