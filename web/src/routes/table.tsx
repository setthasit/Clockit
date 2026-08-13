import {useCallback, useEffect, useMemo, useState} from 'react';
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
import {TipCell} from '../components/TipCell';
import {api} from '../lib/api';
import {reportToCsv} from '../lib/csv';
import {useActiveEmployer} from '../lib/employer';
import {cents, dayLabel, minutesToHM} from '../lib/format';
import {buildRows, shiftsByMemberDay, type Report, type Row} from '../lib/report';
import type {EmployerEntry, ReportDay} from '../lib/types';
import {
  addDays,
  isDayKey,
  monthOf,
  startOfDay,
  todayKey,
  weekStartOf,
  type DayKey,
} from '../lib/week';

const asRange = (start: DayKey, end: DayKey): DateRange => ({
  start: start as ISODateString,
  end: end as ISODateString,
});

const weekRange = (today: DayKey, shiftDays: number): DateRange => {
  const start = addDays(weekStartOf(today), shiftDays);
  return asRange(start, addDays(start, 6));
};

// getRange is re-evaluated whenever the picker asks for it — including on the click that
// applies it — so a page left open overnight still means today, not yesterday's today.
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
 * The displayed range comes from the query string — the calendar's "View in table" link
 * arrives as ?from&to, and picking a range writes them back, so from then on a reload or a
 * shared link shows the same days. A bare /table falls back to this week and leaves the URL
 * alone. Anything that is not two real calendar dates in order falls back the same way,
 * rather than 400ing the report endpoint.
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
  // Both the report and the failure carry the range they belong to, so a stale one is
  // recognised rather than shown: an outgoing banner would otherwise sit over the next
  // range while it loads and suppress the spinner, making a live request read as settled.
  const [failedRange, setFailedRange] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The request this state answers, `from|to|attempt`. A tip save bumps attempt and leaves
  // the old rows on screen while the refetch runs (see TipCell), so for those two requests
  // the day's pool and the shares beside it disagree. On screen that is momentary; in a
  // downloaded file it is permanent and unmarked, so the export waits for the answer.
  const [settled, setSettled] = useState<string | null>(null);
  const reload = useCallback(() => {
    setFailedRange(null);
    setAttempt((n) => n + 1);
  }, []);

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
      })
      .catch(() => {
        if (!cancelled) setFailedRange(`${from}|${to}`);
      })
      .finally(() => {
        if (!cancelled) setSettled(`${from}|${to}|${attempt}`);
      });

    return () => {
      cancelled = true;
    };
  }, [employer.id, tz, from, to, attempt]);

  const loaded = report?.range === `${from}|${to}` ? report : null;
  const hasFailed = failedRange === `${from}|${to}`;
  const isFetching = settled !== `${from}|${to}|${attempt}`;
  const rows = loaded ? buildRows(loaded, tz, from, to) : [];
  const hasUnverified = rows.some((row) => row.isUnverified);
  const columns = useMemo(() => columnsFor(reload), [reload]);

  // The file is the rows on screen — reportToCsv rebuilds them from this same report, and
  // `loaded` is only ever the one answering the range in the URL.
  const exportCsv = () => {
    if (!loaded) return;
    const url = URL.createObjectURL(
      // The BOM is for Excel, which reads a CSV without one in the machine's ANSI codepage
      // and turns every accented name into mojibake.
      new Blob(['\ufeff', reportToCsv(loaded, tz, from, to)], {type: 'text/csv;charset=utf-8'}),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `clockit-report-${from}-${to}.csv`;
    link.click();
    // The file carries hourly rates, and an object URL is readable by anything holding it,
    // so it lives exactly as long as the click that consumed it.
    URL.revokeObjectURL(url);
  };

  return (
    <VStack gap={5}>
      <HStack gap={4} vAlign="end" hAlign="between" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>Table</Heading>
          <Text type="body" color="secondary">
            Hours, tips and pay per day, grouped in {tz.replace(/_/g, ' ')}.
          </Text>
        </VStack>
        <HStack gap={3} vAlign="end" wrap="wrap">
          <DateRangeInput
            label="Date range"
            width={320}
            value={asRange(from, to)}
            // No clear button: there is no report without a range, so clearing would drop
            // the parameters and land straight back on this week — a × that appears to do
            // nothing.
            hasClear={false}
            // Rates never travel in the URL — only day keys.
            onChange={(range) =>
              range && setParams({from: range.start, to: range.end}, {replace: true})
            }
            presets={presetsFor(tz)}
          />
          {/* Nothing on screen is nothing to export, so the button appears only once there
              are rows, and greys out rather than hand over a file already out of date. */}
          {rows.length > 0 && (
            <Button
              label="Export CSV"
              isDisabled={isFetching}
              tooltip={
                isFetching
                  ? 'Refreshing these numbers — the file would be out of date.'
                  : 'Download this range as a CSV.'
              }
              onClick={exportCsv}
            />
          )}
        </HStack>
      </HStack>

      {hasFailed && (
        <Banner
          status="error"
          title="Could not load this report"
          description="Check your connection and try again."
          endContent={<Button label="Retry" variant="secondary" size="sm" onClick={reload} />}
        />
      )}

      {!hasFailed && !loaded && (
        <Center padding={10}>
          <Spinner size="lg" />
        </Center>
      )}

      {rows.length > 0 && <Table data={rows} columns={columns} idKey="key" density="compact" />}

      {/* The dot alone would carry its meaning in colour, reachable only by hover — and on
          touch there is no hover at all. One legend line says it once for the whole table
          instead of a label on every row, and only appears when a dot is on screen. */}
      {hasUnverified && (
        <HStack gap={2} vAlign="center">
          <StatusDot variant="warning" label="Location not verified" />
          <Text type="supporting" color="secondary">
            Amber dot: clocked in outside the work location.
          </Text>
        </HStack>
      )}

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
 * Member rows read as data; day headers and the grand total read as summaries. The total is
 * the row an employer actually pays from, so it steps up a type size as well — bold alone
 * left it reading as one more day group. Astryx's data-driven Table styles cells and not
 * rows, so the distinction has to be made here, in the cells themselves.
 */
const summary = (row: Row, value: string) => (
  <Text
    type={row.kind === 'total' ? 'large' : 'body'}
    weight={row.kind === 'member' ? undefined : 'bold'}>
    {value}
  </Text>
);

/** Built per component, not per module: task 6.2's tip editor has to refetch the report
 *  after a successful PUT, and only the route holds that. */
function columnsFor(onTipSaved: () => void): TableColumn<Row>[] {
  return [
    {
      key: 'label',
      header: 'Employee',
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0.5}>
          <HStack gap={2} vAlign="center">
            {/* Amber, from Astryx's own warning semantic — the same verdict the calendar
                draws as a dashed bar. The legend under the table names it in words. */}
            {row.isUnverified && (
              <StatusDot
                variant="warning"
                label="Location not verified"
                tooltip="Clocked in outside the work location"
              />
            )}
            {summary(row, row.label)}
            {row.tip && <TipCell day={row.tip.day} cents={row.tip.cents} onSaved={onTipSaved} />}
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
      // A member row exists only because the server paid minutes for a closed entry, so a
      // member with no shift joined is a broken join, not an unremarkable row. It reads as
      // missing data rather than as a blank, verified-looking shift with no amber dot.
      renderCell: (row) => (
        <Text type="body" color="secondary">
          {row.kind === 'member' ? (row.times ?? '—') : ''}
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
}
