import {Outlet} from 'react-router';

// ponytail: placeholder — task 2.1 turns this into the Auth0 guard (loading spinner,
// redirect to /sign-in) and task 3.1 wraps it in AppShell.
export function GuardedLayout() {
  return <Outlet />;
}
