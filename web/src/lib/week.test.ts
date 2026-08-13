import {expect, test} from 'vitest';
import {
  addDays,
  assignLanes,
  colorFor,
  dayKey,
  layoutWeek,
  minutesSinceMidnight,
  segmentsFor,
  todayKey,
  weekDays,
  weekStartOf,
} from './week';
import type {EmployerEntry} from './types';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

function entry(overrides: Partial<EmployerEntry> = {}): EmployerEntry {
  return {
    id: 'e1',
    user: {id: 'u1', name: 'Ada', email: 'ada@example.com'},
    status: 'closed',
    clock_in_at: '2026-03-15T13:02:00Z',
    clock_out_at: '2026-03-15T21:35:00Z',
    duration_minutes: 513,
    location_verified: true,
    flags: [],
    ...overrides,
  };
}

const span = ({startMin, endMin}: {startMin: number; endMin: number}) => endMin - startMin;

test('minutes and days come from the employer zone, not the machine zone', () => {
  // 13:02 UTC is 09:02 in a zone behind UTC and 22:02 in one ahead of it.
  expect(minutesSinceMidnight('2026-03-15T13:02:00Z', NY)).toBe(9 * 60 + 2);
  expect(minutesSinceMidnight('2026-03-15T13:02:00Z', TOKYO)).toBe(22 * 60 + 2);

  // 01:30 UTC is still the previous evening in New York — the zone decides the day, so a
  // bar for this instant belongs in Saturday's column at 21:30, not Sunday's at 01:30.
  expect(minutesSinceMidnight('2026-03-15T01:30:00Z', NY)).toBe(21 * 60 + 30);
  expect(dayKey('2026-03-15T01:30:00Z', NY)).toBe('2026-03-14');
  expect(dayKey('2026-03-15T01:30:00Z', TOKYO)).toBe('2026-03-15');

  // Midnight is 0, not 1440: h24 would push a bar off the bottom of the grid.
  expect(minutesSinceMidnight('2026-03-15T04:00:00Z', NY)).toBe(0);

  expect(minutesSinceMidnight('not-a-timestamp', NY)).toBeNull();
  expect(dayKey('not-a-timestamp', NY)).toBeNull();
});

test('day keys step through months, and weeks start on the Sunday', () => {
  expect(addDays('2026-03-15', 1)).toBe('2026-03-16');
  expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');

  expect(weekStartOf('2026-03-18')).toBe('2026-03-15');
  expect(weekStartOf('2026-03-15')).toBe('2026-03-15');
  expect(weekDays('2026-03-15')).toHaveLength(7);
  expect(weekDays('2026-03-15').at(-1)).toBe('2026-03-21');

  expect(todayKey(NY, new Date('2026-03-15T01:30:00Z'))).toBe('2026-03-14');
});

test('a shift inside one day is a single segment', () => {
  expect(segmentsFor(entry(), NY, new Date())).toEqual([
    {day: '2026-03-15', startMin: 9 * 60 + 2, endMin: 17 * 60 + 35},
  ]);
});

test('a midnight-spanning shift splits into pieces that still add up', () => {
  // 22:30 to 07:00 the next morning in New York: 8.5 hours.
  const overnight = entry({
    clock_in_at: '2026-03-16T02:30:00Z',
    clock_out_at: '2026-03-16T11:00:00Z',
    duration_minutes: 510,
  });

  const segments = segmentsFor(overnight, NY, new Date());
  expect(segments).toEqual([
    {day: '2026-03-15', startMin: 22 * 60 + 30, endMin: 1440},
    {day: '2026-03-16', startMin: 0, endMin: 7 * 60},
  ]);
  expect(segments.reduce((total, s) => total + span(s), 0)).toBe(overnight.duration_minutes);
});

test('a shift ending exactly at midnight draws nothing on the next day', () => {
  const segments = segmentsFor(
    entry({clock_in_at: '2026-03-15T20:00:00Z', clock_out_at: '2026-03-16T04:00:00Z'}),
    NY,
    new Date(),
  );
  expect(segments).toEqual([{day: '2026-03-15', startMin: 16 * 60, endMin: 1440}]);
});

test('an open shift runs to now and keeps growing', () => {
  const open = entry({status: 'open', clock_out_at: null, duration_minutes: null});

  expect(segmentsFor(open, NY, new Date('2026-03-15T18:00:00Z'))).toEqual([
    {day: '2026-03-15', startMin: 9 * 60 + 2, endMin: 14 * 60},
  ]);

  // Left running for days: one full-height bar per day in between.
  expect(segmentsFor(open, NY, new Date('2026-03-17T15:00:00Z'))).toEqual([
    {day: '2026-03-15', startMin: 9 * 60 + 2, endMin: 1440},
    {day: '2026-03-16', startMin: 0, endMin: 1440},
    {day: '2026-03-17', startMin: 0, endMin: 11 * 60},
  ]);

  // Clock skew the other way would draw a bar upwards; nothing is drawn instead.
  expect(segmentsFor(open, NY, new Date('2026-03-15T12:00:00Z'))).toEqual([]);
});

test('bars are placed by wall clock across a DST transition', () => {
  // 8 Mar 2026, New York: 01:30 to 04:00 on the clock, but only 90 minutes worked because
  // 02:00 EST jumps to 03:00 EDT. The fixed 24-row grid follows the clock, so the bar is
  // 150 rows-worth tall — see the ponytail note on segmentsFor.
  const springForward = entry({
    clock_in_at: '2026-03-08T06:30:00Z',
    clock_out_at: '2026-03-08T08:00:00Z',
    duration_minutes: 90,
  });

  expect(segmentsFor(springForward, NY, new Date())).toEqual([
    {day: '2026-03-08', startMin: 90, endMin: 240},
  ]);
});

test('overlapping bars split the column and neighbours do not', () => {
  const lanes = (spans: [number, number][]) =>
    assignLanes(spans.map(([startMin, endMin]) => ({day: 'd', startMin, endMin}))).map((s) => [
      s.startMin,
      s.lane,
      s.laneCount,
    ]);

  // Apart in time: both keep the full width.
  expect(lanes([[0, 60], [120, 180]])).toEqual([
    [0, 0, 1],
    [120, 0, 1],
  ]);

  // Overlapping: side by side, half width each.
  expect(lanes([[0, 120], [60, 180]])).toEqual([
    [0, 0, 2],
    [60, 1, 2],
  ]);

  // Touching is not overlapping: a shift starting the minute another ends reuses the lane.
  expect(lanes([[0, 60], [60, 120]])).toEqual([
    [0, 0, 1],
    [60, 0, 1],
  ]);

  // Three at once, then one alone: the busy cluster does not shrink the quiet one.
  expect(lanes([[0, 90], [10, 90], [20, 90], [200, 260]])).toEqual([
    [0, 0, 3],
    [10, 1, 3],
    [20, 2, 3],
    [200, 0, 1],
  ]);
});

test('layoutWeek buckets by day and drops what falls outside the week', () => {
  const week = weekDays('2026-03-15');
  const overnight = entry({
    id: 'e2',
    clock_in_at: '2026-03-16T02:30:00Z',
    clock_out_at: '2026-03-16T11:00:00Z',
  });
  const lastWeek = entry({id: 'e3', clock_in_at: '2026-03-10T13:00:00Z', clock_out_at: '2026-03-10T17:00:00Z'});

  const placed = layoutWeek([entry(), overnight, lastWeek], week, NY, new Date());

  expect([...placed.keys()]).toEqual(week);
  expect(placed.get('2026-03-15')?.map((p) => p.entry.id)).toEqual(['e1', 'e2']);
  expect(placed.get('2026-03-16')?.map((p) => p.entry.id)).toEqual(['e2']);
  expect(placed.get('2026-03-17')).toEqual([]);
});

test('a person keeps the same colour across renders', () => {
  expect(colorFor('user-42')).toEqual(colorFor('user-42'));
  expect(colorFor('user-42').background).toMatch(/^var\(--color-background-[a-z]+\)$/);

  // Eight families, and the hash reaches more than one of them.
  const families = new Set(
    Array.from({length: 200}, (_, i) => colorFor(`user-${i}`).border),
  );
  expect(families.size).toBe(8);
});
