import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

export function OnboardingRoute() {
  return (
    <Section>
      <VStack gap={2}>
        <Heading level={1}>Create employer</Heading>
        <Text type="body" color="secondary">
          Name, timezone and the map anchor picker land here.
        </Text>
      </VStack>
    </Section>
  );
}
