import {useEffect, useState} from 'react';
import {Navigate, Outlet, useLocation} from 'react-router';
import {useAuth0} from '@auth0/auth0-react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {Spinner} from '@astryxdesign/core/Spinner';
import {api, setApiAuth} from '../lib/api';
import type {Employer} from '../lib/types';

// ponytail: this doubles as the ApiProvider — every authenticated request is issued
// under this layout, so a separate wrapper component would only add a file. Task 3.1
// wraps the authenticated branch in AppShell and lifts `employers` into EmployerContext.
export function GuardedLayout() {
  const {isLoading, isAuthenticated, getAccessTokenSilently, loginWithRedirect} = useAuth0();

  // Set during render, not in an effect: it must be in place before this component's
  // own fetch effect below. No child can beat it today (<Outlet/> is unreachable until
  // that fetch resolves), but once task 3.1 lifts `employers` into EmployerContext a
  // child may mount in the same first commit, and child effects run before the parent's.
  // api() fails closed, so getting this wrong throws loudly instead of sending an
  // unauthenticated request.
  setApiAuth({
    getToken: () => getAccessTokenSilently(),
    onUnauthorized: () => void loginWithRedirect(),
  });

  const [employers, setEmployers] = useState<Employer[] | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const {pathname, search} = useLocation();

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;
    api<{employers: Employer[]}>('/v1/employers')
      .then((data) => {
        if (!cancelled) setEmployers(data.employers);
      })
      .catch(() => {
        // The message can carry backend detail; the retry banner is all the user needs.
        if (!cancelled) setEmployers('error');
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, attempt]);

  if (isLoading) {
    return (
      <Center minHeight="100vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  // Carry the wanted path so sign-in can hand it to Auth0 as appState.returnTo.
  if (!isAuthenticated) {
    return <Navigate to="/sign-in" replace state={{returnTo: pathname + search}} />;
  }

  if (employers === 'error') {
    return (
      <Center minHeight="100vh" padding={4}>
        <Banner
          status="error"
          title="Could not load your account"
          description="Check your connection and try again."
          endContent={
            <Button
              label="Retry"
              variant="secondary"
              size="sm"
              onClick={() => {
                setEmployers(null);
                setAttempt((n) => n + 1);
              }}
            />
          }
        />
      </Center>
    );
  }

  if (!employers) {
    return (
      <Center minHeight="100vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  // Onboarding itself renders with zero employers — redirecting from it would loop.
  // ponytail: this bounces task 3.2 back to /onboarding after a successful create,
  // because `employers` is still the [] fetched at boot. 3.2 needs a refresh path;
  // 3.1's EmployerContext is where it belongs.
  if (employers.length === 0 && pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
