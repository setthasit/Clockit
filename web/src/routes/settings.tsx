import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

export function SettingsRoute() {
  return (
    <Section>
      <VStack gap={2}>
        <Heading level={1}>Settings</Heading>
        <Text type="body" color="secondary">
          Employer profile, anchor and danger zone land here.
        </Text>
      </VStack>
    </Section>
  );
}
