// Money and time rendering for employer views. The employer's IANA timezone
// decides day boundaries, so every date formatter takes `tz` explicitly and
// never falls back to the browser's zone. Locale is fixed: the app is English-only.

const usd = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Every money figure arrives as integer cents. A fraction or a NaN is a wire fault, not an
// amount: both renderers pass through here so a value can never read one way on screen and
// another in the exported file.
function whole(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Integer cents to dollars: 1800 → "$18.00", -1800 → "-$18.00", 0 → "$0.00". */
export function cents(n: number): string {
  return usd.format(whole(n) / 100);
}

/**
 * The same amount for machine-read output: 1807 → "18.07", -1800 → "-18.00". No currency
 * symbol and no thousands separator — a CSV field carrying either stops being a number to
 * the spreadsheet that opens it. Exact for every integer cent up to ~4.5e15 — a double
 * holds cents/100 to well within half a cent there, so toFixed(2) names the cent that went
 * in. Above that its spacing exceeds half a cent and the last digit can move: cents() has
 * the same ceiling, and $45 trillion is not a payroll.
 */
export function dollars(n: number): string {
  return (whole(n) / 100).toFixed(2);
}

/**
 * Dollars typed into a rate field back to integer cents — 18.07 → 1807. Rounds rather
 * than truncates: 18.07 * 100 is 1806.9999999999998 in binary floating point, so a
 * truncating conversion would quietly shave a cent off the rate. Non-finite input
 * returns null so the caller skips the request instead of sending NaN, which
 * JSON.stringify would write as null and the backend would reject.
 */
export function toCents(dollars: number): number | null {
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

/** Worked minutes as h:mm — 440 → "7:20". Negative or non-finite clamps to "0:00". */
export function minutesToHM(minutes: number): string {
  const total = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Day header label — "Sun, Mar 15". Accepts an ISO instant or a YYYY-MM-DD report
 * day key. String-only on purpose: a Date carrying the same calendar date takes the
 * instant branch and renders the day before it in western zones. All wire data is
 * JSON strings, so pass the raw value through rather than round-tripping via Date.
 */
export function dayLabel(date: string, tz: string): string {
  // A YYYY-MM-DD value is a calendar date, not an instant: it parses as UTC
  // midnight, and re-zoning that into a western tz would render the day before.
  const dateOnly = DATE_ONLY.test(date);
  const d = toDate(dateOnly ? `${date}T00:00:00Z` : date);
  if (!d) return '—';

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: dateOnly ? 'UTC' : tz,
  }).format(d);
}

/** Shift bounds — "9:02–17:35"; an open shift (no clock-out) renders "9:02–now". */
export function timeRange(inISO: string, outISO: string | null | undefined, tz: string): string {
  const start = clockTime(inISO, tz);
  if (!start) return '—';
  const end = outISO ? (clockTime(outISO, tz) ?? '—') : 'now';
  return `${start}–${end}`;
}

/**
 * One wall-clock time in `tz` — "9:02" — or null when the value will not parse. The table
 * renders the pair as a range and the CSV export gives each end its own column, so both
 * read the same formatter and no exported time can disagree with the one on screen.
 *
 * ponytail: a formatter per call; memoize by tz only if the calendar grid measures slow.
 */
export function clockTime(value: string, tz: string): string | null {
  const d = toDate(value);
  if (!d) return null;

  // h23 pads the hour ("09:02"); the calendar and table want "9:02".
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  })
    .format(d)
    .replace(/^0/, '');
}
