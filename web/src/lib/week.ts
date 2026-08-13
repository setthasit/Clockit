// Geometry for the calendar week grid. Every instant is resolved in the employer's IANA
// timezone: the operator's browser is routinely in a different zone from the job site, so
// nothing here may fall back to the machine zone. Same trap as lib/format.ts — a calendar
// date is a YYYY-MM-DD string, never a Date, because a Date is an instant and re-zoning it
// moves it a day.

import type {EmployerEntry} from './types';

const MINUTES_PER_DAY = 1440;
const DAYS_PER_WEEK = 7;

/** A calendar date in the employer's zone, YYYY-MM-DD. Sorts and compares as a string. */
export type DayKey = string;

const formatters = new Map<string, Intl.DateTimeFormat>();

// One formatter per zone: the grid resolves two instants per entry per render, and
// constructing an Intl.DateTimeFormat is the expensive half of that.
function formatter(tz: string): Intl.DateTimeFormat {
  let cached = formatters.get(tz);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // h23 so midnight reads 00 rather than h24's 24, which would land a bar off the grid.
      hourCycle: 'h23',
    });
    formatters.set(tz, cached);
  }
  return cached;
}

interface Zoned {
  day: DayKey;
  /** Minutes since midnight of `day`, 0–1439. */
  minutes: number;
}

function zonedDate(d: Date, tz: string): Zoned {
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(d)) parts[part.type] = part.value;

  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Wall-clock day and minutes-since-midnight of a UTC instant, in `tz`. */
export function zoned(iso: string, tz: string): Zoned | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : zonedDate(d, tz);
}

export function minutesSinceMidnight(iso: string, tz: string): number | null {
  return zoned(iso, tz)?.minutes ?? null;
}

export function dayKey(iso: string, tz: string): DayKey | null {
  return zoned(iso, tz)?.day ?? null;
}

export function todayKey(tz: string, now: Date = new Date()): DayKey {
  return zonedDate(now, tz).day;
}

/** Day-key arithmetic in pure UTC — a calendar date carries no zone and no DST. */
export function addDays(day: DayKey, n: number): DayKey {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + n)).toISOString().slice(0, 10);
}

/** The Sunday on or before `day`. */
export function weekStartOf(day: DayKey): DayKey {
  const [year, month, date] = day.split('-').map(Number);
  return addDays(day, -new Date(Date.UTC(year, month - 1, date)).getUTCDay());
}

export function weekDays(weekStart: DayKey): DayKey[] {
  return Array.from({length: DAYS_PER_WEEK}, (_, i) => addDays(weekStart, i));
}

/** Minutes `tz` is ahead of UTC at the instant `ms`. */
function offsetMinutes(ms: number, tz: string): number {
  const {day, minutes} = zonedDate(new Date(ms), tz);
  const [year, month, date] = day.split('-').map(Number);
  const wallClock = Date.UTC(year, month - 1, date) + minutes * 60_000;
  // The formatter stops at the minute, so the instant it is compared against must too.
  return (wallClock - Math.floor(ms / 60_000) * 60_000) / 60_000;
}

/**
 * The UTC instant at which `day` begins in `tz`, as RFC3339 — the form the entries API
 * takes for its window. A calendar date names a wall-clock midnight, and the offset that
 * midnight sits at is only knowable once you know roughly which instant it is: so guess
 * from UTC midnight, then correct by the offset actually in force there. The second pass
 * settles days whose first guess landed on the far side of a DST transition.
 *
 * Where wall-clock midnight does not exist — Santiago and Havana spring forward at
 * midnight, running 00:00 straight to 01:00 — neither pass lands on `day`, and the day
 * begins at the transition itself: the later of the two candidates. Iterating instead of
 * choosing would never terminate, because the two candidates trade places forever.
 *
 * ponytail: where midnight instead happens twice — a zone cutting its offset just after
 * midnight, so the clock rewinds through it — this returns the second one, up to three
 * hours late. It is still minute zero of the right day, and only `from` is affected
 * (a late `to` only widens the window), so at worst the lead-in day loses shifts clocked
 * in during the repeat. Last occurrences in the current tzdb: Asia/Amman and Asia/Gaza
 * 2021, Antarctica/Casey and Antarctica/Vostok 2023. Upgrade path: replace both probes
 * with a binary search over [utcMidnight - 26h, utcMidnight + 26h] for the first minute
 * whose zoned day is `day` — exact for repeats too, at ~16 formatter calls instead of 2.
 */
export function startOfDay(day: DayKey, tz: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, date);
  const guess = utcMidnight - offsetMinutes(utcMidnight, tz) * 60_000;
  const corrected = utcMidnight - offsetMinutes(guess, tz) * 60_000;
  const start =
    zonedDate(new Date(corrected), tz).day === day ? corrected : Math.max(guess, corrected);

  return new Date(start).toISOString();
}

export interface Segment {
  day: DayKey;
  startMin: number;
  endMin: number;
}

/**
 * The wall-clock pieces an entry occupies, one per calendar day it touches. Both edges are
 * read off the instants rather than off duration_minutes, so a bar always spans exactly the
 * times its own label shows. An open entry runs to `now`.
 *
 * ponytail: bars are placed by wall clock on a fixed 24-row grid, so a spring-forward day's
 * 23 real hours still occupy 24 rows. Every bar sits at the row its clock time names — which
 * is what the employer reads — but a shift crossing a transition is drawn an hour longer or
 * shorter than it was worked. Upgrade path: derive each day column's row count from the tz
 * offset delta across that day and scale that column's pxPerMin.
 */
export function segmentsFor(entry: EmployerEntry, tz: string, now: Date): Segment[] {
  const start = zoned(entry.clock_in_at, tz);
  if (!start) return [];

  const current = zonedDate(now, tz);
  // ponytail: an open entry stops at the end of its clock-in day. Running it to `now` paints
  // a full-height bar on every later day of the week after one forgotten clock-out, and those
  // bars overlap everything, so assignLanes squeezes each real entry on those days to 1/N of
  // the column and the week becomes unreadable. A bar reaching midnight and still pulsing
  // reads as "open, ran past the end of the day". Ceiling: a genuine shift longer than 24h is
  // drawn short. Upgrade path: extend the cap to the employer's maximum shift length once
  // that setting exists, and keep segmenting to `now` below it.
  const end = entry.clock_out_at
    ? zoned(entry.clock_out_at, tz)
    : current.day > start.day
      ? {day: start.day, minutes: MINUTES_PER_DAY}
      : current;
  if (!end) return [];

  // Clock skew — the backend tolerates ±5 min — or an open entry clocked in a moment ahead of
  // this browser. A bar drawn upwards is wrong, but dropping the entry is worse: it would
  // vanish from the calendar while the report still counts it. Zero length lands at
  // MIN_BAR_HEIGHT and stays clickable.
  if (end.day < start.day || (end.day === start.day && end.minutes < start.minutes)) {
    return [{day: start.day, startMin: start.minutes, endMin: start.minutes}];
  }

  if (start.day === end.day) {
    return [{day: start.day, startMin: start.minutes, endMin: end.minutes}];
  }

  const segments: Segment[] = [{day: start.day, startMin: start.minutes, endMin: MINUTES_PER_DAY}];
  for (let day = addDays(start.day, 1); day < end.day; day = addDays(day, 1)) {
    segments.push({day, startMin: 0, endMin: MINUTES_PER_DAY});
  }
  // A shift ending exactly at midnight leaves nothing to draw on the following day.
  if (end.minutes > 0) segments.push({day: end.day, startMin: 0, endMin: end.minutes});

  return segments;
}

export interface Laned {
  lane: number;
  laneCount: number;
}

/**
 * Side-by-side placement for bars overlapping in time: sorted by start, each takes the first
 * lane free at that moment. The lane count is per cluster of mutually overlapping bars, so
 * one busy hour does not squeeze the rest of the day into a sliver.
 */
export function assignLanes<T extends Segment>(items: T[]): (T & Laned)[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const placed: (T & Laned)[] = [];
  let ends: number[] = [];
  let clusterFrom = 0;

  const closeCluster = () => {
    for (let i = clusterFrom; i < placed.length; i++) placed[i].laneCount = ends.length;
  };

  for (const item of sorted) {
    // Nothing still running: the cluster is over and lanes reset to the full column width.
    if (ends.length > 0 && ends.every((end) => end <= item.startMin)) {
      closeCluster();
      ends = [];
      clusterFrom = placed.length;
    }

    // A bar starting exactly when another ends does not overlap it, so it reuses the lane.
    let lane = ends.findIndex((end) => end <= item.startMin);
    if (lane === -1) lane = ends.length;
    ends[lane] = item.endMin;

    placed.push({...item, lane, laneCount: 0});
  }
  closeCluster();

  return placed;
}

export interface PlacedEntry extends Segment, Laned {
  entry: EmployerEntry;
}

/** Every entry cut into day segments, laned, and bucketed by day. Days outside `days` drop. */
export function layoutWeek(
  entries: EmployerEntry[],
  days: DayKey[],
  tz: string,
  now: Date,
): Map<DayKey, PlacedEntry[]> {
  const buckets = new Map<DayKey, (Segment & {entry: EmployerEntry})[]>(days.map((d) => [d, []]));

  for (const entry of entries) {
    for (const segment of segmentsFor(entry, tz, now)) {
      buckets.get(segment.day)?.push({...segment, entry});
    }
  }

  return new Map([...buckets].map(([day, segments]) => [day, assignLanes(segments)]));
}

/**
 * The height of one hour row. Both WeekCalendar and EntryBar measure against it and
 * neither can own it: WeekCalendar renders EntryBar, so the import would only run one way.
 */
export const ROW_HEIGHT = 'var(--spacing-12)';

/** A duration in minutes as grid height. */
export function hoursTall(minutes: number): string {
  return `calc(${ROW_HEIGHT} * ${minutes / 60})`;
}

/**
 * Eight of Astryx's categorical colour families. Red is left out because it means error
 * here, and gray because it means disabled.
 */
const PALETTE = ['blue', 'purple', 'teal', 'orange', 'green', 'pink', 'cyan', 'yellow'] as const;

export interface EntryColor {
  background: string;
  border: string;
  text: string;
}

/**
 * A stable colour per person. Hashed from the member id rather than assigned by position in
 * the response, which is ordered by clock-in time and would repaint the whole week whenever
 * someone new clocked in.
 */
export function colorFor(memberId: string): EntryColor {
  // djb2, two lines and deterministic across reloads.
  let hash = 5381;
  for (let i = 0; i < memberId.length; i++) {
    hash = ((hash << 5) + hash + memberId.charCodeAt(i)) | 0;
  }
  const family = PALETTE[Math.abs(hash) % PALETTE.length];

  return {
    background: `var(--color-background-${family})`,
    border: `var(--color-border-${family})`,
    text: `var(--color-text-${family})`,
  };
}
