// Row shaping for the payroll table. Pure and zone-explicit, like week.ts: the employer's
// IANA timezone decides which day a shift clocked in on, never the browser's.
//
// The web only formats money. The single exception lives here — buildRows adds the per-day
// totals the report endpoint returns into a range total it does not — and must stay the
// only one: every other figure is rendered exactly as the server computed it.

import {dayLabel, timeRange} from './format';
import type {EmployerEntry, ReportDay} from './types';
import {dayKey, type DayKey} from './week';

/** One rendered line. Day headers, member rows and the grand total share one column set,
 *  so every figure sits under the heading that names it. */
export type Row = {
  /** React list key and the Table's `idKey`. Nothing may join on its shape. */
  key: string;
  kind: 'day' | 'member' | 'total';
  /** Date label, member name, or the grand-total caption. */
  label: string;
  /** Day headers only — the day's tip pool, which task 6.2 makes editable. */
  tip: {day: DayKey; cents: number} | null;
  note: string | null;
  /** Member rows only. null means no shift joined, which is a broken join, not a quiet
   *  state: a member row exists only because the server paid minutes for a closed entry.
   *  The cell renders it as missing data rather than as an empty, verified-looking shift. */
  times: string | null;
  /** Member rows only — the closed shifts behind this row's minutes, in worked order; empty
   *  on day and total rows. `times` is these same shifts as one cell, and the CSV gives each
   *  end its own column: one join, so the two can never disagree and no reader has to
   *  reconstruct the key they were bucketed under. */
  shifts: EmployerEntry[];
  isUnverified: boolean;
  minutes: number;
  rateCents: number | null;
  basePayCents: number | null;
  tipShareCents: number;
  totalCents: number;
};

export interface Report {
  /** The range this answers, `from|to`. Day rows carry their own dates, so the outgoing
   *  range must not stay on screen under a new one — a mismatch here reads as loading. */
  range: string;
  days: ReportDay[];
  /** Closed shifts by `${day}|${userId}`, in clock-in order. */
  shifts: Map<string, EmployerEntry[]>;
}

/**
 * Closed shifts bucketed by the day they clocked in on, which is how the report groups
 * them too. Open shifts are left out on purpose: the report pays no minutes for one, so
 * showing its hours next to a total that excludes them would contradict the money.
 */
export function shiftsByMemberDay(
  entries: EmployerEntry[],
  tz: string,
): Map<string, EmployerEntry[]> {
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

export function buildRows({days, shifts}: Report, tz: string, from: DayKey, to: DayKey): Row[] {
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
      shifts: [],
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
        shifts: worked,
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
    shifts: [],
    isUnverified: false,
    minutes: grand.minutes,
    rateCents: null,
    basePayCents: grand.basePay,
    tipShareCents: grand.tipShare,
    totalCents: grand.total,
  });

  return rows;
}
