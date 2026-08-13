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

  // Set during render, not in an effect: child effects run before the parent's, so an
  // effect here would let a child's first request go out without a token.
  setApiAuth({
    getToken: () => getAccessTokenSilently(),
    onUnauthorized: () => void loginWithRedirect(),
  });

  const [employers, setEmployers] = useState<Employer[] | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const {pathname} = useLocation();

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

  if (!isAuthenticated) return <Navigate to="/sign-in" replace />;

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
  if (employers.length === 0 && pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
