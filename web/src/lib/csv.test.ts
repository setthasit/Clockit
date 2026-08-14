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
    last_ping_at: null,
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

/**
 * One money column added up over every data line, in cents. Naive on purpose — the fixtures
 * that use it carry plain names, so no field is quoted and no field holds a comma. It is
 * the sum a bookkeeper's SUM() would produce.
 */
function columnSum(out: string, column: number): number {
  return out
    .split('\r\n')
    .slice(1)
    .reduce((total, line) => total + Math.round(Number(line.split(',')[column]) * 100), 0);
}

test('the file is member lines only — a summary line would be counted twice by SUM()', () => {
  const lines = csv([reportDay()], [entry()]).split('\r\n');

  expect(lines[0]).toBe(HEADER);
  // The day header and the range total stay on screen: both repeat this line's money, and
  // there is no column a spreadsheet could filter them out by.
  expect(lines[1]).toBe('2026-03-15,Ada,9:02,12:00,2:58,18.07,53.61,50.00,103.61');
  // Records are separated, not terminated: a trailing CRLF is an empty record to a parser.
  expect(lines).toHaveLength(2);
});

test('every money column sums to what actually happened', () => {
  const busy = reportDay({
    total_base_pay_cents: 7361,
    total_cents: 12361,
    rows: [
      reportRow({tip_share_cents: 3000, total_cents: 8361}),
      reportRow({
        user: {id: 'u2', name: 'Bo', email: 'bo@example.com'},
        minutes: 120,
        hourly_rate_cents: 1000,
        base_pay_cents: 2000,
        tip_share_cents: 2000,
        total_cents: 4000,
      }),
    ],
  });
  // $25 entered on a day whose only shift rounded to zero minutes: real rows, no shares.
  const unpaidPool = reportDay({
    date: '2026-03-16',
    tip_cents: 2500,
    total_minutes: 0,
    total_base_pay_cents: 0,
    total_tip_share_cents: 0,
    total_cents: 0,
    rows: [reportRow({minutes: 0, base_pay_cents: 0, tip_share_cents: 0, total_cents: 0})],
  });

  const out = csv([busy, unpaidPool], [], '2026-03-16');

  // base_pay is what was earned for hours, tip_share every cent the employer typed — the
  // $25 nobody could be paid included — and total the payroll actually owed.
  expect(columnSum(out, 6)).toBe(7361);
  expect(columnSum(out, 7)).toBe(3000 + 2000 + 0 + 2500);
  expect(columnSum(out, 8)).toBe(8361 + 4000 + 0);
});

test('quoting survives commas, quotes and newlines in a name', () => {
  const awkward = csv([
    reportDay({
      rows: [
        reportRow({user: {id: 'u1', name: 'Smith, Ada', email: 'ada@example.com'}}),
        reportRow({user: {id: 'u2', name: 'Ada "Bo" Byron', email: 'bo@example.com'}}),
        reportRow({user: {id: 'u3', name: 'Ada\r\nByron', email: 'byron@example.com'}}),
        reportRow({user: {id: 'u4', name: 'Ada\nLovelace', email: 'lovelace@example.com'}}),
        reportRow({user: {id: 'u5', name: 'Ada "', email: 'quote@example.com'}}),
      ],
    }),
  ]);

  // A comma in a field would otherwise open a tenth column and shift the money right.
  expect(awkward).toContain('\r\n2026-03-15,"Smith, Ada",');
  // Quotes double; the field is not re-escaped some other way.
  expect(awkward).toContain('\r\n2026-03-15,"Ada ""Bo"" Byron",');
  // A CRLF inside quotes is one record to a parser, and unquoted it would be two.
  expect(awkward).toContain('\r\n2026-03-15,"Ada\r\nByron",');
  // A bare LF ends a record just as surely: it is not the file's own terminator, so a
  // writer that only looked for \r\n would leave this one unquoted and split the row.
  expect(awkward).toContain('\r\n2026-03-15,"Ada\nLovelace",');
  // One unpaired quote, which is the field that swallows the rest of the file if the
  // doubling is skipped: quoted and doubled like any other.
  expect(awkward).toContain('\r\n2026-03-15,"Ada """,');
  // Nothing else is quoted: quoting every field would be valid but unreadable.
  expect(awkward).not.toContain('"2026-03-15"');
});

test('a name that would run as a formula is marked as text', () => {
  const hostile = csv([
    reportDay({
      rows: [
        reportRow({user: {id: 'u1', name: '=1+1', email: 'a@example.com'}}),
        reportRow({user: {id: 'u2', name: '@SUM(A1)', email: 'b@example.com'}}),
        reportRow({user: {id: 'u3', name: '+41 555', email: 'c@example.com'}}),
        reportRow({user: {id: 'u4', name: '-lead', email: 'd@example.com'}}),
        reportRow({user: {id: 'u5', name: '\t=1+1', email: 'e@example.com'}}),
        reportRow({user: {id: 'u6', name: "O'Brien", email: 'f@example.com'}}),
      ],
    }),
  ]);

  // The file carries hourly rates, and a name is the one field a person chooses: a leading
  // apostrophe is what stops Excel and Sheets evaluating it against the rate column.
  expect(hostile).toContain("\r\n2026-03-15,'=1+1,");
  expect(hostile).toContain("\r\n2026-03-15,'@SUM(A1),");
  expect(hostile).toContain("\r\n2026-03-15,'+41 555,");
  expect(hostile).toContain("\r\n2026-03-15,'-lead,");
  // A leading tab is skipped before the formula check, so it has to be caught too.
  expect(hostile).toContain("\r\n2026-03-15,'\t=1+1,");
  // An apostrophe anywhere but the front is a name, not a marker, and is left alone.
  expect(hostile).toContain("\r\n2026-03-15,O'Brien,");
  // Machine-generated columns keep their values: a prefixed date stops being a date.
  expect(hostile).not.toContain("'2026-03-15");
});

test('two shifts in a day list both ends, in worked order', () => {
  const morning = entry({id: 'morning'});
  const afternoon = entry({
    id: 'afternoon',
    // 13:00–17:35 in New York, and posted by the endpoint before the morning shift.
    clock_in_at: '2026-03-15T17:00:00Z',
    clock_out_at: '2026-03-15T21:35:00Z',
  });

  const member = csv([reportDay()], [afternoon, morning]).split('\r\n')[1];

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
  ]).split('\r\n')[1];

  // Rate and base pay are empty fields: nobody has decided this member's pay yet, and
  // "0.00" would read as a decision. The tip share they are still owed stands.
  // The unnamed member falls back to their email, as every other view does.
  // No entry joined, so both time columns are empty rather than a made-up shift.
  expect(noRate).toBe('2026-03-15,bo@example.com,,,2:58,,,50.00,50.00');
});

test('a pool that reached nobody gets its own line, worked day or not', () => {
  // Two ways the pool and the shares part: nobody clocked in at all, and everybody's shift
  // rounded to zero minutes. The backend splits all-or-nothing, so both leave the whole
  // pool unshared — and keying on the empty-rows case alone would lose the second one.
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
      reportDay({
        date: '2026-03-17',
        tip_cents: 1000,
        total_minutes: 0,
        total_base_pay_cents: 0,
        total_tip_share_cents: 0,
        total_cents: 0,
        rows: [reportRow({minutes: 0, base_pay_cents: 0, tip_share_cents: 0, total_cents: 0})],
      }),
    ],
    [entry()],
    '2026-03-17',
  ).split('\r\n');

  // The pool is printed as it arrived — the split leaves nothing behind to subtract — and
  // the total is zero because nobody was paid it, so SUM(total) stays real payroll.
  expect(lines[2]).toBe('2026-03-16,Unassigned tip,,,,,,25.00,0.00');
  expect(lines[3]).toBe('2026-03-17,Unassigned tip,,,,,,10.00,0.00');
  // The zero-minute day still has its member line; the unassigned one does not replace it.
  expect(lines[4]).toBe('2026-03-17,Ada,,,0:00,18.07,0.00,0.00,0.00');
  expect(lines).toHaveLength(5);
  // A day whose pool was split gets no such line: it is already in the member shares.
  expect(lines[1]).toContain(',Ada,');
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
  expect(lines[1]).toBe('2026-03-15,Ada,,,2:58,18.07,18.07,1000000.00,1000018.07');
});

test('an empty range exports the header alone', () => {
  // A header-only file opens as an empty table. Returning "" would look like a failed
  // export, and the button is anyway not offered when there is nothing to send.
  expect(csv([])).toBe(HEADER);
});
