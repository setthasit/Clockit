import {useEffect, useState} from 'react';
import {useSearchParams} from 'react-router';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import type {ISODateString} from '@astryxdesign/core/Calendar';
import {Center} from '@astryxdesign/core/Center';
import {
  DateRangeInput,
  type DateRange,
  type DateRangePreset,
} from '@astryxdesign/core/DateRangeInput';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Spinner} from '@astryxdesign/core/Spinner';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {pixel, proportional, Table, type TableColumn} from '@astryxdesign/core/Table';
import {Heading, Text} from '@astryxdesign/core/Text';
import {api} from '../lib/api';
import {useActiveEmployer} from '../lib/employer';
import {cents, dayLabel, minutesToHM, timeRange} from '../lib/format';
import type {EmployerEntry, ReportDay} from '../lib/types';
import {
  addDays,
  dayKey,
  isDayKey,
  monthOf,
  startOfDay,
  todayKey,
  weekStartOf,
  type DayKey,
} from '../lib/week';

/** One rendered line. Day headers, member rows and the grand total share one column set,
 *  so every figure sits under the heading that names it. */
type Row = {
  key: string;
  kind: 'day' | 'member' | 'total';
  /** Date label, member name, or the grand-total caption. */
  label: string;
  /** Day headers only — the day's tip pool, which task 6.2 makes editable. */
  tip: {day: DayKey; cents: number} | null;
  note: string | null;
  /** Member rows only; null when no shift matched (see shiftsByMemberDay). */
  times: string | null;
  isUnverified: boolean;
  minutes: number;
  rateCents: number | null;
  basePayCents: number | null;
  tipShareCents: number;
  totalCents: number;
};

interface Report {
  /** The range this answers, `from|to`. Day rows carry their own dates, so the outgoing
   *  range must not stay on screen under a new one — a mismatch here reads as loading. */
  range: string;
  days: ReportDay[];
  /** Closed shifts by `${day}|${userId}`, in clock-in order. */
  shifts: Map<string, EmployerEntry[]>;
}

const asRange = (start: DayKey, end: DayKey): DateRange => ({
  start: start as ISODateString,
  end: end as ISODateString,
});

const weekRange = (today: DayKey, shiftDays: number): DateRange => {
  const start = addDays(weekStartOf(today), shiftDays);
  return asRange(start, addDays(start, 6));
};

// Evaluated per click, not per render: a page left open overnight still means today.
function presetsFor(tz: string): DateRangePreset[] {
  return [
    {label: 'This week', getRange: () => weekRange(todayKey(tz), 0)},
    {label: 'Last week', getRange: () => weekRange(todayKey(tz), -7)},
    {
      label: 'This month',
      getRange: () => {
        const {start, end} = monthOf(todayKey(tz));
        return asRange(start, end);
      },
    },
  ];
}

/**
 * The displayed range lives in the query string — the calendar's "View in table" link
 * arrives as ?from&to, and the URL stays the single source of truth so a reload or a
 * shared link shows the same days. Anything that is not two real calendar dates in order
 * falls back to this week rather than 400ing the report endpoint.
 */
function rangeFromParams(params: URLSearchParams, tz: string): DateRange {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return isDayKey(from) && isDayKey(to) && from <= to
    ? asRange(from, to)
    : weekRange(todayKey(tz), 0);
}

export function TableRoute() {
  const employer = useActiveEmployer();
  const tz = employer.timezone;
  const [params, setParams] = useSearchParams();
  const {start: from, end: to} = rangeFromParams(params, tz);

  // No employer tag on any of this state: Shell keys <Outlet/> by employer id, so a
  // switch remounts the route and clears all of it at once.
  const [report, setReport] = useState<Report | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const reportQuery = new URLSearchParams({from, to});
    // ponytail: a second call, because the report carries no clock-in/out instants and no
    // location verdict — only per-member day totals. This is the only honest source for
    // the in–out column and the unverified dot, and it windows on clock-in exactly as the
    // report groups by it, so the two agree row for row. Ceiling: a range with thousands of
    // shifts ships them all to render one column. Upgrade path: add the two instants and
    // the verdict to the report rows and drop this call.
    const entriesQuery = new URLSearchParams({
      from: startOfDay(from, tz),
      to: startOfDay(addDays(to, 1), tz),
    });

    Promise.all([
      api<{days: ReportDay[]}>(`/v1/employers/${employer.id}/report?${reportQuery}`),
      api<{entries: EmployerEntry[]}>(`/v1/employers/${employer.id}/entries?${entriesQuery}`),
    ])
      .then(([days, entries]) => {
        if (cancelled) return;
        setReport({
          range: `${from}|${to}`,
          days: days.days,
          shifts: shiftsByMemberDay(entries.entries, tz),
        });
        setHasFailed(false);
      })
      .catch(() => {
        if (!cancelled) setHasFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [employer.id, tz, from, to, attempt]);

  const loaded = report?.range === `${from}|${to}` ? report : null;
  const rows = loaded ? buildRows(loaded, tz, from, to) : [];

  return (
    <VStack gap={5}>
      <HStack gap={4} vAlign="end" hAlign="between" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>Table</Heading>
          <Text type="body" color="secondary">
            Hours, tips and pay per day, grouped in {tz.replace(/_/g, ' ')}.
          </Text>
        </VStack>
        <DateRangeInput
          label="Date range"
          width={320}
          value={asRange(from, to)}
          // Clearing drops the parameters and the range falls back to this week; there is
          // no report to show without one. Rates never travel in the URL — only day keys.
          onChange={(range) =>
            setParams(range ? {from: range.start, to: range.end} : {}, {replace: true})
          }
          presets={presetsFor(tz)}
        />
      </HStack>

      {hasFailed && (
        <Banner
          status="error"
          title="Could not load this report"
          description="Check your connection and try again."
          endContent={
            <Button
              label="Retry"
              variant="secondary"
              size="sm"
              // Back to the spinner: leaving the banner up until the retry resolves
              // reads as a dead button.
              onClick={() => {
                setHasFailed(false);
                setAttempt((n) => n + 1);
              }}
            />
          }
        />
      )}

      {!hasFailed && !loaded && (
        <Center padding={10}>
          <Spinner size="lg" />
        </Center>
      )}

      {rows.length > 0 && <Table data={rows} columns={COLUMNS} idKey="key" density="compact" />}

      {loaded?.days.length === 0 && (
        <EmptyState
          title="Nothing to pay in this range"
          description={`Nobody worked and no tips were entered between ${dayLabel(from, tz)} and ${dayLabel(to, tz)}.`}
        />
      )}
    </VStack>
  );
}

/**
 * Closed shifts bucketed by the day they clocked in on, which is how the report groups
 * them too. Open shifts are left out on purpose: the report pays no minutes for one, so
 * showing its hours next to a total that excludes them would contradict the money.
 */
function shiftsByMemberDay(entries: EmployerEntry[], tz: string): Map<string, EmployerEntry[]> {
  const byMemberDay = new Map<string, EmployerEntry[]>();

  // The entries endpoint answers newest first; a member's second shift of the day must
  // still read after their first.
  const chronological = entries
    .filter((entry) => entry.clock_out_at !== null)
    .sort((a, b) => Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at));

  for (const entry of chronological) {
    const day = dayKey(entry.clock_in_at, tz);
    if (!day) continue;
    const key = `${day}|${entry.user.id}`;
    const bucket = byMemberDay.get(key);
    if (bucket) bucket.push(entry);
    else byMemberDay.set(key, [entry]);
  }

  return byMemberDay;
}

function buildRows({days, shifts}: Report, tz: string, from: DayKey, to: DayKey): Row[] {
  const rows: Row[] = [];
  const grand = {minutes: 0, basePay: 0, tipShare: 0, total: 0};

  for (const day of days) {
    rows.push({
      key: day.date,
      kind: 'day',
      label: dayLabel(day.date, tz),
      tip: {day: day.date, cents: day.tip_cents},
      note: day.rows.length === 0 ? 'Nobody worked this day, so this tip is unassigned.' : null,
      times: null,
      isUnverified: false,
      minutes: day.total_minutes,
      rateCents: null,
      basePayCents: day.total_base_pay_cents,
      tipShareCents: day.total_tip_share_cents,
      totalCents: day.total_cents,
    });

    // The only arithmetic on this page: the endpoint returns no range totals, so these add
    // up the per-day totals it does return. Nothing else here is derived — every per-day
    // and per-member figure is rendered exactly as the server computed it.
    grand.minutes += day.total_minutes;
    grand.basePay += day.total_base_pay_cents;
    grand.tipShare += day.total_tip_share_cents;
    grand.total += day.total_cents;

    for (const row of day.rows) {
      const worked = shifts.get(`${day.date}|${row.user.id}`) ?? [];
      rows.push({
        key: `${day.date}|${row.user.id}`,
        kind: 'member',
        // An invited member who never signed in has no name, but can have no shifts either;
        // the email is the fallback the rest of the app uses.
        label: row.user.name || row.user.email,
        tip: null,
        note: null,
        times: worked.map((e) => timeRange(e.clock_in_at, e.clock_out_at, tz)).join(', ') || null,
        isUnverified: worked.some((e) => !e.location_verified),
        minutes: row.minutes,
        rateCents: row.hourly_rate_cents,
        basePayCents: row.base_pay_cents,
        tipShareCents: row.tip_share_cents,
        totalCents: row.total_cents,
      });
    }
  }

  if (rows.length === 0) return rows;

  // ponytail: a body row, not a <tfoot>. Astryx's TableFooter is children-mode only, which
  // would mean hand-rolling the header cells and column widths this table gets for free.
  // Upgrade path if the totals must stick to the viewport: move the whole table to children
  // mode and put this row in TableFooter.
  rows.push({
    key: 'range-total',
    kind: 'total',
    label: `Range total · ${dayLabel(from, tz)} – ${dayLabel(to, tz)}`,
    tip: null,
    note: null,
    times: null,
    isUnverified: false,
    minutes: grand.minutes,
    rateCents: null,
    basePayCents: grand.basePay,
    tipShareCents: grand.tipShare,
    totalCents: grand.total,
  });

  return rows;
}

/** Member rows read as data; the day header and the grand total read as summaries. */
const weightOf = (row: Row) => (row.kind === 'member' ? undefined : 'bold');

const summary = (row: Row, value: string) => (
  <Text type="body" weight={weightOf(row)}>
    {value}
  </Text>
);

const COLUMNS: TableColumn<Row>[] = [
  {
    key: 'label',
    header: 'Employee',
    width: proportional(2),
    renderCell: (row) => (
      <VStack gap={0.5}>
        <HStack gap={2} vAlign="center">
          {/* Amber, from Astryx's own warning semantic — the same verdict the calendar
              draws as a dashed bar. */}
          {row.isUnverified && (
            <StatusDot
              variant="warning"
              label="Location not verified"
              tooltip="Clocked in outside the work location"
            />
          )}
          {summary(row, row.label)}
          {row.tip && <DayTip day={row.tip.day} cents={row.tip.cents} />}
        </HStack>
        {row.note && (
          <Text type="supporting" color="secondary">
            {row.note}
          </Text>
        )}
      </VStack>
    ),
  },
  {
    key: 'times',
    header: 'In–out',
    width: proportional(1),
    renderCell: (row) => (
      <Text type="body" color="secondary">
        {row.times ?? ''}
      </Text>
    ),
  },
  {
    key: 'minutes',
    header: 'Hours',
    width: pixel(90),
    align: 'end',
    renderCell: (row) => summary(row, minutesToHM(row.minutes)),
  },
  {
    key: 'rateCents',
    header: 'Rate',
    width: pixel(110),
    align: 'end',
    renderCell: (row) =>
      row.kind !== 'member' ? null : (
        <Text type="body" color={row.rateCents === null ? 'secondary' : undefined}>
          {row.rateCents === null ? 'Not set' : cents(row.rateCents)}
        </Text>
      ),
  },
  {
    key: 'basePayCents',
    header: 'Base pay',
    width: pixel(120),
    align: 'end',
    // Blank, not zero: a member with no rate has earned an amount nobody has decided yet.
    renderCell: (row) => summary(row, row.basePayCents === null ? '—' : cents(row.basePayCents)),
  },
  {
    key: 'tipShareCents',
    header: 'Tip share',
    width: pixel(120),
    align: 'end',
    renderCell: (row) => summary(row, cents(row.tipShareCents)),
  },
  {
    key: 'totalCents',
    header: 'Total',
    width: pixel(120),
    align: 'end',
    renderCell: (row) => summary(row, cents(row.totalCents)),
  },
];

/**
 * ponytail: the day's tip pool, read-only. Task 6.2 replaces this component's body with the
 * inline editor that PUTs on blur; the day it writes to and the amount it starts from are
 * already its props, so the call site above does not move.
 */
function DayTip({cents: amount}: {day: DayKey; cents: number}) {
  return (
    <Text type="supporting" color="secondary">
      Tips {cents(amount)}
    </Text>
  );
}
