import {useEffect, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {VStack} from '@astryxdesign/core/Layout';
import {Skeleton} from '@astryxdesign/core/Skeleton';
import {Heading, Text} from '@astryxdesign/core/Text';
import {WeekCalendar} from '../components/WeekCalendar';
import {api} from '../lib/api';
import {useActiveEmployer} from '../lib/employer';
import type {EmployerEntry} from '../lib/types';
import {addDays, ROW_HEIGHT, startOfDay, todayKey, weekStartOf, type DayKey} from '../lib/week';

// Close enough to the grid it stands in for; it is a shimmer, not a measurement.
const GRID_SKELETON_HEIGHT = `calc(${ROW_HEIGHT} * 25)`;

export function CalendarRoute() {
  const employer = useActiveEmployer();
  const tz = employer.timezone;

  // No employer tag on any of this state: Shell keys <Outlet/> by employer id, so a
  // switch remounts the route and clears all of it at once.
  const [weekStart, setWeekStart] = useState<DayKey>(() => weekStartOf(todayKey(tz)));
  const [entries, setEntries] = useState<EmployerEntry[] | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams({
      // A day early on purpose: the backend windows on clock_in only, so a Saturday-night
      // shift running into this week is otherwise never returned. layoutWeek drops whatever
      // still falls outside the seven displayed days.
      from: startOfDay(addDays(weekStart, -1), tz),
      to: startOfDay(addDays(weekStart, 7), tz),
    });

    api<{entries: EmployerEntry[]}>(`/v1/employers/${employer.id}/entries?${params}`)
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries);
        setHasFailed(false);
      })
      .catch(() => {
        if (!cancelled) setHasFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [employer.id, tz, weekStart, attempt]);

  return (
    <VStack gap={5}>
      <VStack gap={1}>
        <Heading level={1}>Calendar</Heading>
        <Text type="body" color="secondary">
          Every shift this week, laid out in {tz.replace(/_/g, ' ')}.
        </Text>
      </VStack>

      {hasFailed && (
        <Banner
          status="error"
          title="Could not load this week"
          description="Check your connection and try again."
          endContent={<Button label="Retry" variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)} />}
        />
      )}

      {/* The skeleton stands in only until the first week lands. Paging to another week
          keeps the grid up — losing it would take the week controls with it, and a Next
          button that vanishes under the cursor cannot be clicked twice. The outgoing week's
          entries are harmless meanwhile: layoutWeek drops everything outside the days now
          on screen, so the grid empties rather than showing the wrong week. */}
      {entries === null ? (
        !hasFailed && <Skeleton height={GRID_SKELETON_HEIGHT} />
      ) : (
        <WeekCalendar
          weekStart={weekStart}
          onWeekStartChange={setWeekStart}
          tz={tz}
          entries={entries}
        />
      )}

      {/* ponytail: no in-flight flag, so paging off an already-empty week onto a busy one
          leaves this up until the new entries land a moment later. It never contradicts the
          grid — both are showing the same (empty) data. Upgrade path if it ever reads wrong:
          tag each response with the week it answers and compare against weekStart. */}
      {entries?.length === 0 && (
        <EmptyState
          title="No shifts this week"
          description="Nobody clocked in across these seven days. Try another week."
        />
      )}
    </VStack>
  );
}
