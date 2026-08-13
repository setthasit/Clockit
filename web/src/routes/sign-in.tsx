import {Navigate} from 'react-router';
import {useAuth0} from '@auth0/auth0-react';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {VStack} from '@astryxdesign/core/Layout';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Heading, Text} from '@astryxdesign/core/Text';

export function SignInRoute() {
  const {isLoading, isAuthenticated, loginWithRedirect} = useAuth0();

  if (isLoading) {
    return (
      <Center minHeight="100vh">
        <Spinner size="lg" />
      </Center>
    );
  }

  if (isAuthenticated) return <Navigate to="/calendar" replace />;

  return (
    <Center minHeight="100vh" padding={4}>
      <VStack gap={4} hAlign="center" maxWidth={420}>
        <Heading level={1}>ClockIt</Heading>
        <Text type="body" color="secondary">
          Shifts, hours and payroll for your crew — clocked from the job site.
        </Text>
        <Button
          label="Sign in"
          variant="primary"
          size="lg"
          clickAction={() => loginWithRedirect()}
        />
      </VStack>
    </Center>
  );
}
