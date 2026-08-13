import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Layout';
import {Heading, Text} from '@astryxdesign/core/Text';

export function EmployeesRoute() {
  return (
    <Section padding={4}>
      <VStack gap={2}>
        <Heading level={1}>Employees</Heading>
        <Text type="body" color="secondary">
          Member list, invites and rates land here.
        </Text>
      </VStack>
    </Section>
  );
}
