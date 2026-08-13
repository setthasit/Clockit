import {expect, test} from 'vitest';
import {reportToCsv} from './csv';
import {shiftsByMemberDay, type Report} from './report';
import type {EmployerEntry, ReportDay, ReportRow} from './types';

const NY = 'America/New_York';
const HEADER = 'date,employee,clock_in,clock_out,hours,rate,base_pay,tip_share,total';

function entry(overrides: Partial<EmployerEntry> = {}): EmployerEntry {
  return {
    id: 'e1',
    user: {id: 'u1', name: 'Ada', email: 'ada@example.com'},
    status: 'closed',
    // 09:02–12:00 in New York.
    clock_in_at: '2026-03-15T13:02:00Z',
    clock_out_at: '2026-03-15T16:00:00Z',
    duration_minutes: 178,
    location_verified: true,
    flags: [],
    ...overrides,
  };
}

function reportRow(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    user: {id: 'u1', name: 'Ada', email: 'ada@example.com'},
    minutes: 178,
    hourly_rate_cents: 1807,
    base_pay_cents: 5361,
    tip_share_cents: 5000,
    total_cents: 10361,
    ...overrides,
  };
}

function reportDay(overrides: Partial<ReportDay> = {}): ReportDay {
  return {
    date: '2026-03-15',
    tip_cents: 5000,
    total_minutes: 178,
    total_base_pay_cents: 5361,
    total_tip_share_cents: 5000,
    total_cents: 10361,
    rows: [reportRow()],
    ...overrides,
  };
}

const report = (days: ReportDay[], entries: EmployerEntry[] = []): Report => ({
  range: '',
  days,
  shifts: shiftsByMemberDay(entries, NY),
});

const csv = (days: ReportDay[], entries: EmployerEntry[] = [], to = '2026-03-15') =>
  reportToCsv(report(days, entries), NY, '2026-03-15', to);

test('a day, its members and the range total, in the order the table shows them', () => {
  const lines = csv([reportDay()], [entry()]).split('\r\n');

  expect(lines[0]).toBe(HEADER);
  // The day header keeps its own date; the member row inherits it from the header above.
  expect(lines[1]).toBe('2026-03-15,Day total,,,2:58,,53.61,50.00,103.61');
  expect(lines[2]).toBe('2026-03-15,Ada,9:02,12:00,2:58,18.07,53.61,50.00,103.61');
  // The total spans the range, so no single date belongs to it — and its label carries the
  // commas of two dates, which is why the whole field is quoted.
  expect(lines[3]).toBe(',"Range total · Sun, Mar 15 – Sun, Mar 15",,,2:58,,53.61,50.00,103.61');
  // Records are separated, not terminated: a trailing CRLF is an empty record to a parser.
  expect(lines).toHaveLength(4);
});

test('quoting survives commas, quotes and newlines in a name', () => {
  const awkward = csv([
    reportDay({
      rows: [
        reportRow({user: {id: 'u1', name: 'Smith, Ada', email: 'ada@example.com'}}),
        reportRow({user: {id: 'u2', name: 'Ada "Bo" Byron', email: 'bo@example.com'}}),
        reportRow({user: {id: 'u3', name: 'Ada\r\nByron', email: 'byron@example.com'}}),
      ],
    }),
  ]);

  // A comma in a field would otherwise open a tenth column and shift the money right.
  expect(awkward).toContain('\r\n2026-03-15,"Smith, Ada",');
  // Quotes double; the field is not re-escaped some other way.
  expect(awkward).toContain('\r\n2026-03-15,"Ada ""Bo"" Byron",');
  // A CRLF inside quotes is one record to a parser, and unquoted it would be two.
  expect(awkward).toContain('\r\n2026-03-15,"Ada\r\nByron",');
  // Nothing else is quoted: quoting every field would be valid but unreadable.
  expect(awkward).not.toContain('"2026-03-15"');
});

test('two shifts in a day list both ends, in worked order', () => {
  const morning = entry({id: 'morning'});
  const afternoon = entry({
    id: 'afternoon',
    // 13:00–17:35 in New York, and posted by the endpoint before the morning shift.
    clock_in_at: '2026-03-15T17:00:00Z',
    clock_out_at: '2026-03-15T21:35:00Z',
  });

  const member = csv([reportDay()], [afternoon, morning]).split('\r\n')[2];

  // Each column carries its own end of both shifts, so the pairs line up across them —
  // and the comma between them is what makes the quoting matter on a data row.
  expect(member).toContain(',"9:02, 13:00","12:00, 17:35",');
});

test('unknown money is blank and never 0.00, and a joined shift is not invented', () => {
  const noRate = csv([
    reportDay({
      total_base_pay_cents: 0,
      total_cents: 5000,
      rows: [
        reportRow({
          user: {id: 'u2', name: '', email: 'bo@example.com'},
          hourly_rate_cents: null,
          base_pay_cents: null,
          total_cents: 5000,
        }),
      ],
    }),
  ]).split('\r\n')[2];

  // Rate and base pay are empty fields: nobody has decided this member's pay yet, and
  // "0.00" would read as a decision. The tip share they are still owed stands.
  // The unnamed member falls back to their email, as every other view does.
  // No entry joined, so both time columns are empty rather than a made-up shift.
  expect(noRate).toBe('2026-03-15,bo@example.com,,,2:58,,,50.00,50.00');
});

test('a tip nobody worked for stays in the file', () => {
  const lines = csv(
    [
      reportDay(),
      reportDay({
        date: '2026-03-16',
        tip_cents: 2500,
        total_minutes: 0,
        total_base_pay_cents: 0,
        total_tip_share_cents: 0,
        total_cents: 0,
        rows: [],
      }),
    ],
    [entry()],
    '2026-03-16',
  ).split('\r\n');

  // The day's shares are zero because nobody was there to take them — but the $25 the
  // employer typed is real money awaiting a correction, so the line reports the pool and
  // names itself. Its total stays the server's zero: nobody has been paid it.
  expect(lines[3]).toBe('2026-03-16,Unassigned tip,,,0:00,,0.00,25.00,0.00');
  // The range total is the server's day totals added up, so it excludes the unpaid pool.
  expect(lines.at(-1)).toContain(',50.00,103.61');
});

test('money is exact to the cent, with no symbol or grouping', () => {
  const lines = csv([
    reportDay({
      tip_cents: 100_000_000,
      total_base_pay_cents: 1807,
      total_tip_share_cents: 100_000_000,
      total_cents: 100_001_807,
      rows: [
        reportRow({
          base_pay_cents: 1807,
          tip_share_cents: 100_000_000,
          total_cents: 100_001_807,
        }),
      ],
    }),
  ]).split('\r\n');

  // 1807/100 is 18.069999999999999 to a float, and 100_000_000 cents carries a thousands
  // separator through Intl — either would land in the file as something other than the
  // number on screen, and the separator would split the field into two columns.
  expect(lines[1]).toBe('2026-03-15,Day total,,,2:58,,18.07,1000000.00,1000018.07');
  expect(lines[2]).toBe('2026-03-15,Ada,,,2:58,18.07,18.07,1000000.00,1000018.07');
});

test('an empty range exports the header alone', () => {
  // A header-only file opens as an empty table. Returning "" would look like a failed
  // export, and the button is anyway not offered when there is nothing to send.
  expect(csv([])).toBe(HEADER);
});
