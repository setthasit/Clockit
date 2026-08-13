import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

export function SignInRoute() {
  return (
    <Section padding={4}>
      <VStack gap={2}>
        <Heading level={1}>Sign in</Heading>
        <Text type="body" color="secondary">
          Auth0 sign-in lands here.
        </Text>
      </VStack>
    </Section>
  );
}
