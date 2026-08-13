// The payroll table as a file the employer hands to a bookkeeper. It runs buildRows itself
// rather than shaping the report a second way, so the file is the rows on screen — same
// days, same members, same order — and every figure is the server's, only formatted.
//
// Pure and DOM-free: the download is the route's business, this is the string.

import {clockTime, dollars, minutesToHM} from './format';
import {buildRows, type Report, type Row} from './report';
import type {DayKey} from './week';

const HEADER = 'date,employee,clock_in,clock_out,hours,rate,base_pay,tip_share,total';

// RFC 4180 §2.6–2.7: a field is quoted only when it holds a comma, a quote, CR or LF, and a
// quote inside a quoted field is written twice. Employee names and emails are user-supplied,
// so this is what stands between a name holding a comma and every later column shifting.
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Blank, never "0.00": an unknown amount and a zero one are different facts to a payroll. */
function money(amountCents: number | null): string {
  return amountCents === null ? '' : dollars(amountCents);
}

/**
 * Day headers and the range total carry no person, and their date is already in its own
 * column, so this column says what the line is instead of repeating it. `note` is set on
 * exactly the day the report emits with no rows — a tip nobody worked for.
 */
function employee(row: Row): string {
  if (row.kind === 'member' || row.kind === 'total') return row.label;
  return row.note ? 'Unassigned tip' : 'Day total';
}

export function reportToCsv(report: Report, tz: string, from: DayKey, to: DayKey): string {
  const lines = [HEADER];
  let date: DayKey = '';

  for (const row of buildRows(report, tz, from, to)) {
    // Day rows are the only ones carrying `tip`, and they precede the members they cover,
    // so the header's date is the date of every member row until the next header.
    if (row.tip) date = row.tip.day;

    // The member row's key is `${day}|${userId}` — the key shiftsByMemberDay buckets under
    // — so this is the same join the In–out column renders, not a second read of the data.
    const shifts = row.kind === 'member' ? (report.shifts.get(row.key) ?? []) : [];

    const cells = [
      row.kind === 'total' ? '' : date,
      employee(row),
      // Two shifts in one day are one row on screen and one row here: each column lists its
      // own end of every shift, in worked order. Only closed shifts are bucketed, so a
      // clock-out is always there to name.
      shifts.map((e) => clockTime(e.clock_in_at, tz) ?? '').join(', '),
      shifts.map((e) => (e.clock_out_at ? (clockTime(e.clock_out_at, tz) ?? '') : '')).join(', '),
      // h:mm, exactly as the Hours column reads. Decimal hours would be the client dividing
      // minutes it was given — the range total in report.ts stays this view's only sum.
      minutesToHM(row.minutes),
      money(row.rateCents),
      money(row.basePayCents),
      // A day row reports its tip pool, a member row their share of it. The two agree
      // whenever anybody worked; they part on a day nobody did, where the shares are zero
      // and a file showing only those would drop money the employer typed in. That line is
      // labelled "Unassigned tip", and its total stays the server's — nobody was paid it.
      money(row.tip ? row.tip.cents : row.tipShareCents),
      money(row.totalCents),
    ];

    lines.push(cells.map(field).join(','));
  }

  // CRLF per RFC 4180 §2.1, and no trailing one: a final empty line reads as an empty record
  // to strict parsers. An empty range leaves the header alone, which opens as a table with
  // no rows rather than as a file that failed to generate.
  return lines.join('\r\n');
}
