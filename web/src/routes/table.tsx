import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

export function TableRoute() {
  return (
    <Section>
      <VStack gap={2}>
        <Heading level={1}>Table</Heading>
        <Text type="body" color="secondary">
          Day-grouped hours, tips and CSV export land here.
        </Text>
      </VStack>
    </Section>
  );
}
