import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

export function CalendarRoute() {
  return (
    <Section padding={4}>
      <VStack gap={2}>
        <Heading level={1}>Calendar</Heading>
        <Text type="body" color="secondary">
          The week view lands here.
        </Text>
      </VStack>
    </Section>
  );
}
