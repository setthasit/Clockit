import {useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Section} from '@astryxdesign/core/Section';
import {Selector} from '@astryxdesign/core/Selector';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {useToast} from '@astryxdesign/core/Toast';
import {MapAnchorPicker, type AnchorValue} from '../components/MapAnchorPicker';
import {api, ApiError} from '../lib/api';
import {useActiveEmployer, useEmployer} from '../lib/employer';
import {timezoneOptions} from '../lib/timezones';
import type {Employer} from '../lib/types';

interface EmployerPatch {
  name?: string;
  timezone?: string;
  anchor?: {lat: number; lng: number};
}

export function SettingsRoute() {
  const employer = useActiveEmployer();
  const {updateEmployer} = useEmployer();
  const toast = useToast();

  // Seeded once, and re-seeded from the response after each save. Shell keys <Outlet/> by
  // employer id, so switching employers remounts this route with the other one's values.
  const [name, setName] = useState(employer.name);
  const [timezone, setTimezone] = useState(employer.timezone);
  const [anchor, setAnchor] = useState<AnchorValue>(employer.anchor);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const isNameChanged = trimmedName !== employer.name;
  const isTimezoneChanged = timezone !== employer.timezone;
  const isAnchorChanged =
    anchor.lat !== employer.anchor.lat || anchor.lng !== employer.anchor.lng;
  const hasChanges = isNameChanged || isTimezoneChanged || isAnchorChanged;

  const submit = async () => {
    if (isNameChanged && !trimmedName) {
      setError('Enter a name for this employer.');
      return;
    }
    if (isAnchorChanged && (anchor.lat === null || anchor.lng === null)) {
      setError('Set the job-site anchor: drop a pin on the map, or type its coordinates.');
      return;
    }
    setError(null);

    // Only what moved: every field is optional and an omitted one is left alone, so an
    // untouched form has nothing to send — and this route is rate-limited.
    const patch: EmployerPatch = {};
    if (isNameChanged) patch.name = trimmedName;
    if (isTimezoneChanged) patch.timezone = timezone;
    if (isAnchorChanged && anchor.lat !== null && anchor.lng !== null) {
      patch.anchor = {lat: anchor.lat, lng: anchor.lng};
    }

    try {
      const {employer: saved} = await api<{employer: Employer}>(`/v1/employers/${employer.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      updateEmployer(saved);
      // The name is the only field the server rewrites (it trims), so it is the only one
      // worth re-seeding: without it " Acme " would differ from "Acme" forever and every
      // later save would resend a name that never changed. Timezone and anchor come back
      // verbatim. The inputs stay live during the save, so keep anything typed since.
      setName((current) => (current.trim() === saved.name ? saved.name : current));
      toast({body: 'Settings saved.'});
    } catch (e) {
      setError(saveErrorMessage(e));
    }
  };

  return (
    <Section maxWidth={640} padding={0} variant="transparent">
      <VStack gap={6}>
        <VStack gap={1}>
          <Heading level={1}>Settings</Heading>
          <Text type="body" color="secondary">
            The name, working-day timezone and job-site anchor this employer runs on.
          </Text>
        </VStack>

        <TextInput label="Name" value={name} onChange={setName} isRequired />

        <Selector
          label="Timezone"
          description="Decides where each working day starts and ends."
          options={timezoneOptions(employer.timezone)}
          value={timezone}
          onChange={setTimezone}
          hasSearch
          searchPlaceholder="Search timezones..."
          isRequired
        />

        <VStack gap={3}>
          <Heading level={3}>Job-site anchor</Heading>
          <Banner
            status="info"
            title="Moving the anchor affects future clock-ins only."
            description="Shifts already recorded keep the verdict they were given."
          />
          <MapAnchorPicker value={anchor} onChange={setAnchor} />
        </VStack>

        {/* Beside the button, not at the top of the form: the map and coordinate fields
            put most of a screen between the two, so a submit error up there is scrolled
            out of view by the time the button is reachable. */}
        <VStack gap={3}>
          {error && <Banner status="error" title={error} />}

          <HStack gap={3} hAlign="end">
            <Button
              label="Save changes"
              variant="primary"
              // Nothing to save is nothing to send. The button re-disabling itself after a
              // save is also the confirmation for an anchor or timezone edit, neither of
              // which shows anywhere else on this page.
              isDisabled={!hasChanges}
              tooltip={hasChanges ? undefined : 'Nothing has changed yet.'}
              clickAction={submit}
            />
          </HStack>
        </VStack>
      </VStack>
    </Section>
  );
}

function saveErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Could not save these settings. Try again.';
  // Keyed off code, not status: the error catalog is the contract clients are meant to
  // branch on. These two messages ("too many requests", "not found") offer no way
  // forward; every other one names the field or the fault and is worth showing as-is.
  if (e.code === 'RATE_LIMITED') return 'Too many changes just now. Wait a minute, then save again.';
  if (e.code === 'NOT_FOUND') {
    return 'This employer is no longer available. Pick another one from the employer menu.';
  }
  return e.message;
}
