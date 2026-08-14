import {Navigate, useLocation} from 'react-router';
import {useAuth0} from '@auth0/auth0-react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {VStack} from '@astryxdesign/core/Layout';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Heading, Text} from '@astryxdesign/core/Text';
import {useDocumentTitle} from '../lib/title';

export function SignInRoute() {
  const {isLoading, isAuthenticated, error, loginWithRedirect} = useAuth0();
  // Before the early returns below: hooks run in the same order on every render.
  useDocumentTitle('Sign in');

  // The guard puts the path the user asked for in location state; main.tsx's
  // onRedirectCallback navigates to appState.returnTo once Auth0 comes back.
  const {state} = useLocation();
  const returnTo = (state as {returnTo?: string} | null)?.returnTo ?? '/calendar';

  if (isLoading) {
    return (
      <Center minHeight="100vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  if (isAuthenticated) return <Navigate to={returnTo} replace />;

  return (
    <Center minHeight="100vh" padding={4}>
      <VStack gap={4} hAlign="center" maxWidth={420}>
        <Heading level={1}>ClockIt</Heading>
        <Text type="body" color="secondary">
          Shifts, hours and payroll for your crew — clocked from the job site.
        </Text>
        {/* A tenant misconfiguration (missing client grant, wrong audience, no
            offline_access) comes back as ?error= on the redirect, which the provider
            turns into this error instead of a session — so the click looks like it did
            nothing. error.message is Auth0's error_description (or a fixed SDK message
            like "Invalid state"): developer-facing text about the tenant, carrying no
            token, session id or PII.
            ponytail: error_description is verbatim attacker-controllable text in an
            official-looking banner (text injection, not XSS — React escapes it), only
            reachable in a tab holding an abandoned login transaction. Accepted. */}
        {error && <Banner status="error" title="Sign-in failed" description={error.message} />}
        <Button
          label="Sign in"
          variant="primary"
          size="lg"
          clickAction={() => loginWithRedirect({appState: {returnTo}})}
        />
      </VStack>
    </Center>
  );
}
