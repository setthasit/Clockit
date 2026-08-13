import {useCallback, useEffect, useMemo, useState} from 'react';
import {Navigate, Outlet, useLocation} from 'react-router';
import {useAuth0} from '@auth0/auth0-react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {Spinner} from '@astryxdesign/core/Spinner';
import {api, setApiAuth} from '../lib/api';
import {EMPLOYER_ID_KEY, EmployerContext, type EmployerState} from '../lib/employer';
import type {Employer} from '../lib/types';

// Stable empty list for the loading and error states, so the context memo below does not
// rebuild on every render while the fetch is in flight.
const NO_EMPLOYERS: Employer[] = [];

// A failed login (bad audience, missing grant) comes back to '/' as ?error=&state= and
// leaves this guard unauthenticated, so those params would ride into returnTo and be put
// back in the address bar after the *next*, successful login. A reload there hits the SDK's
// hasAuthParams() — (code|error) && state — with no live transaction and shows an "Invalid
// state" banner over a perfectly good session. Nothing this app links to uses these names.
const AUTH_PARAMS_RE = /[?&](code|state|error)=/;

// Merely touching window.localStorage throws SecurityError where storage is blocked
// (Chrome with all cookies blocked, some embedded webviews). Auth0 runs with
// cacheLocation="memory", so failing soft here keeps the app fully usable — the employer
// choice just does not survive a reload.
function readStoredEmployerId(): string | null {
  try {
    return localStorage.getItem(EMPLOYER_ID_KEY);
  } catch {
    return null;
  }
}

// ponytail: this doubles as the ApiProvider and the EmployerContext provider — every
// authenticated request is issued under this layout and the employer list is already
// fetched here, so separate wrapper components would only add files and a second fetch.
export function GuardedLayout() {
  const {isLoading, isAuthenticated, getAccessTokenSilently, loginWithRedirect} = useAuth0();

  // Set during render, not in an effect: it must be in place before this component's own
  // fetch effect below, which is the first api() call of the session. It also covers the
  // hypothetical case of a child mounting in the same commit — child effects run before
  // the parent's — though no child can do that today, since <Outlet/> sits behind every
  // early return until that fetch resolves. api() fails closed, so getting this wrong
  // throws loudly instead of sending an unauthenticated request.
  setApiAuth({
    getToken: () => getAccessTokenSilently(),
    onUnauthorized: () => void loginWithRedirect(),
  });

  const [employers, setEmployers] = useState<Employer[] | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState(readStoredEmployerId);
  const {pathname, search} = useLocation();

  // Serves both the error Banner's Retry and EmployerContext.refresh().
  // The two states differ on purpose: refresh() is called from a child inside <Outlet/>,
  // so clearing the list would unmount the very component that called it (and flash a
  // whole-app spinner on every mutation). From 'error' there is nothing on screen worth
  // keeping and Retry does want the spinner back.
  const refresh = useCallback(() => {
    setEmployers((prev) => (prev === 'error' ? null : prev));
    setAttempt((n) => n + 1);
  }, []);

  const setEmployerId = useCallback((id: string) => {
    try {
      localStorage.setItem(EMPLOYER_ID_KEY, id);
    } catch {
      // Blocked storage: the selection below still applies for this session.
    }
    setSelectedId(id);
  }, []);

  // Onboarding's create path. Both updates land before the caller's navigate() in the
  // same batch, so the zero-employer redirect below never sees the stale empty list.
  const addEmployer = useCallback(
    (employer: Employer) => {
      setEmployers((prev) => (Array.isArray(prev) ? [...prev, employer] : [employer]));
      setEmployerId(employer.id);
    },
    [setEmployerId],
  );

  // Settings' save path. No setEmployerId: an edit can only reach the employer that is
  // already active, so the selection is unchanged.
  const updateEmployer = useCallback((employer: Employer) => {
    setEmployers((prev) =>
      Array.isArray(prev) ? prev.map((e) => (e.id === employer.id ? employer : e)) : prev,
    );
  }, []);

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

  // Above the early returns to keep hook order stable. Memoised because refresh() is the
  // kind of value a child drops into a useEffect dep array, where a new identity on every
  // navigation (this component calls useLocation()) would loop.
  const employerList = employers === null || employers === 'error' ? NO_EMPLOYERS : employers;
  const value = useMemo<EmployerState>(
    () => ({
      employers: employerList,
      // Fall back to the first employer: a stored id can name one that was deleted or
      // belongs to another account, and stranding the user on nothing is worse than a
      // switch. The stale id is never rewritten, so that fallback simply resolves the
      // same way on every load until the user picks someone — deterministic, and cheaper
      // than a write-back effect.
      employer: employerList.find((e) => e.id === selectedId) ?? employerList[0] ?? null,
      setEmployerId,
      addEmployer,
      updateEmployer,
      refresh,
    }),
    [employerList, selectedId, setEmployerId, addEmployer, updateEmployer, refresh],
  );

  if (isLoading) {
    return (
      <Center minHeight="100vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  // Carry the wanted path so sign-in can hand it to Auth0 as appState.returnTo.
  if (!isAuthenticated) {
    const returnTo = AUTH_PARAMS_RE.test(search) ? pathname : pathname + search;
    return <Navigate to="/sign-in" replace state={{returnTo}} />;
  }

  if (employers === 'error') {
    return (
      <Center minHeight="100vh" padding={4}>
        <Banner
          status="error"
          title="Could not load your account"
          description="Check your connection and try again."
          endContent={
            <Button label="Retry" variant="secondary" size="sm" onClick={refresh} />
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
  // A create there calls addEmployer(), so the new employer is already in this list by
  // the render that its navigate() produces.
  if (employers.length === 0 && pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <EmployerContext value={value}>
      <Outlet />
    </EmployerContext>
  );
}
