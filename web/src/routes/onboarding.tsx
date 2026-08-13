import {useState} from 'react';
import {useNavigate} from 'react-router';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Section} from '@astryxdesign/core/Section';
import {Selector} from '@astryxdesign/core/Selector';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {MapAnchorPicker, type AnchorValue} from '../components/MapAnchorPicker';
import {api, ApiError} from '../lib/api';
import {useEmployer} from '../lib/employer';
import type {Employer} from '../lib/types';

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const IANA_TIMEZONES = Intl.supportedValuesOf('timeZone');

// Some browsers still resolve to a non-canonical alias ("Asia/Calcutta") that
// supportedValuesOf() omits. The backend accepts those, so the only thing missing them
// costs is a select that opens blank on the value it is already set to.
const TIMEZONE_OPTIONS = IANA_TIMEZONES.includes(BROWSER_TIMEZONE)
  ? IANA_TIMEZONES
  : [BROWSER_TIMEZONE, ...IANA_TIMEZONES];

const NO_ANCHOR: AnchorValue = {lat: null, lng: null};

export function OnboardingRoute() {
  const navigate = useNavigate();
  const {employers, addEmployer} = useEmployer();

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(BROWSER_TIMEZONE);
  const [anchor, setAnchor] = useState<AnchorValue>(NO_ANCHOR);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Enter a name for this employer.');
      return;
    }
    if (anchor.lat === null || anchor.lng === null) {
      setError('Set the job-site anchor: drop a pin on the map, or type its coordinates.');
      return;
    }
    setError(null);

    try {
      const {employer} = await api<{employer: Employer}>('/v1/employers', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmedName,
          timezone,
          anchor: {lat: anchor.lat, lng: anchor.lng},
        }),
      });
      // Seed-then-navigate, never refresh-then-navigate: the guard redirects /employees
      // back here while its list is empty, and refresh() would still be in flight. React
      // batches both of these into the single render the navigation produces.
      addEmployer(employer);
      navigate('/employees');
    } catch (e) {
      // ApiError carries the backend's own INVALID_ARGUMENT message, which names the field.
      setError(
        e instanceof ApiError ? e.message : 'Could not create the employer. Try again.',
      );
    }
  };

  return (
    <Center axis="horizontal">
      <Section maxWidth={640} padding={6} paddingBlock={10}>
        <VStack gap={6}>
          <VStack gap={2}>
            <Heading level={1}>Create employer</Heading>
            <Text type="body" color="secondary">
              Name the business, set the timezone its working days are counted in, and drop
              the anchor your crew clocks in from.
            </Text>
          </VStack>

          <TextInput
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Northside Roofing"
            isRequired
          />

          <Selector
            label="Timezone"
            description="Decides where each working day starts and ends."
            options={TIMEZONE_OPTIONS}
            value={timezone}
            onChange={setTimezone}
            hasSearch
            searchPlaceholder="Search timezones..."
            isRequired
          />

          <VStack gap={3}>
            <Heading level={3}>Job-site anchor</Heading>
            <MapAnchorPicker value={anchor} onChange={setAnchor} />
          </VStack>

          {/* Beside the button, not at the top of the form: the map and coordinate fields
              put over 1000 px between the two, so a submit error up there is off-screen. */}
          <VStack gap={3}>
            {error && <Banner status="error" title={error} />}

            <HStack gap={3} hAlign="end">
              {/* Only when there is somewhere to go back to: this page has no nav chrome. */}
              {employers.length > 0 && (
                <Button label="Cancel" variant="ghost" onClick={() => navigate('/calendar')} />
              )}
              <Button label="Create employer" variant="primary" clickAction={submit} />
            </HStack>
          </VStack>
        </VStack>
      </Section>
    </Center>
  );
}
