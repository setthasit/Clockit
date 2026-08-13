import {expect, test} from 'vitest';
import {buildRows, shiftsByMemberDay, type Report} from './report';
import type {EmployerEntry, ReportDay, ReportRow} from './types';

const NY = 'America/New_York';

function entry(overrides: Partial<EmployerEntry> = {}): EmployerEntry {
  return {
    id: 'e1',
    user: {id: 'u1', name: 'Ada', email: 'ada@example.com'},
    status: 'closed',
    clock_in_at: '2026-03-15T13:02:00Z',
    clock_out_at: '2026-03-15T16:00:00Z',
    duration_minutes: 178,
    location_verified: true,
    flags: [],
    ...overrides,
  };
}

// 09:02–12:00 and 13:00–17:35 in New York, the same day.
const morning = entry({id: 'morning'});
const afternoon = entry({
  id: 'afternoon',
  clock_in_at: '2026-03-15T17:00:00Z',
  clock_out_at: '2026-03-15T21:35:00Z',
  location_verified: false,
});

function reportRow(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    user: {id: 'u1', name: 'Ada', email: 'ada@example.com'},
    minutes: 453,
    hourly_rate_cents: 1200,
    base_pay_cents: 9060,
    tip_share_cents: 5000,
    total_cents: 14060,
    ...overrides,
  };
}

function reportDay(overrides: Partial<ReportDay> = {}): ReportDay {
  return {
    date: '2026-03-15',
    tip_cents: 5000,
    total_minutes: 453,
    total_base_pay_cents: 9060,
    total_tip_share_cents: 5000,
    total_cents: 14060,
    rows: [reportRow()],
    ...overrides,
  };
}

// `range` is the route's staleness tag, not an input to the rows.
const report = (days: ReportDay[], entries: EmployerEntry[]): Report => ({
  range: '',
  days,
  shifts: shiftsByMemberDay(entries, NY),
});

test('shifts bucket under the employer-zone day they clocked in on, oldest first', () => {
  // The endpoint answers newest first, and a second shift must still read after the first.
  const open = entry({id: 'open', status: 'open', clock_out_at: null, duration_minutes: null});
  // 02:30 UTC is still the previous evening in New York, so this belongs to the 15th.
  const lateNight = entry({
    id: 'late',
    clock_in_at: '2026-03-16T02:30:00Z',
    clock_out_at: '2026-03-16T04:00:00Z',
  });

  const shifts = shiftsByMemberDay([lateNight, afternoon, morning, open], NY);

  expect(shifts.get('2026-03-15|u1')?.map((e) => e.id)).toEqual([
    'morning',
    'afternoon',
    'late',
  ]);
  // An open shift pays no minutes in the report, so it must not show hours next to it.
  expect([...shifts.values()].flat().some((e) => e.id === 'open')).toBe(false);
  expect(shifts.get('2026-03-16|u1')).toBeUndefined();
});

test('rows: a line per day and member, and the range total is the sum of the days', () => {
  const unassignedTip = reportDay({
    date: '2026-03-16',
    tip_cents: 2500,
    total_minutes: 0,
    total_base_pay_cents: 0,
    total_tip_share_cents: 0,
    total_cents: 0,
    rows: [],
  });
  // A day whose member row has no entry to join to — see the unjoined-row assertion below.
  const unjoined = reportDay({
    date: '2026-03-17',
    tip_cents: 0,
    total_minutes: 120,
    total_base_pay_cents: 0,
    total_tip_share_cents: 0,
    total_cents: 0,
    rows: [
      reportRow({
        user: {id: 'u2', name: '', email: 'bo@example.com'},
        minutes: 120,
        hourly_rate_cents: null,
        base_pay_cents: null,
        tip_share_cents: 0,
        total_cents: 0,
      }),
    ],
  });

  const rows = buildRows(
    report([reportDay(), unassignedTip, unjoined], [afternoon, morning]),
    NY,
    '2026-03-15',
    '2026-03-17',
  );

  expect(rows.map((r) => r.kind)).toEqual(['day', 'member', 'day', 'day', 'member', 'total']);

  // Both of the day's shifts land on the one member row, in the order they were worked.
  const worked = rows[1];
  expect(worked.times).toBe('9:02–12:00, 13:00–17:35');
  // The same join, carried rather than left to be rebuilt: the CSV needs each shift's two
  // instants as separate columns, and re-deriving the bucket key would couple it to the
  // shape of `key`. Summary rows stand for no shift of their own.
  expect(worked.shifts.map((e) => e.id)).toEqual(['morning', 'afternoon']);
  expect(rows[0].shifts).toEqual([]);
  expect(rows.at(-1)!.shifts).toEqual([]);
  // Either shift outside the anchor lights the dot; here it is the afternoon one.
  expect(worked.isUnverified).toBe(true);

  // A tip with nobody to share it still gets a line, carrying the note that says so.
  const tipOnly = rows[2];
  expect(tipOnly.tip).toEqual({day: '2026-03-16', cents: 2500});
  expect(tipOnly.note).toContain('unassigned');

  // Nothing joined: null, which the cell renders as "—". A blank would be indistinguishable
  // from a verified shift, since [].some() is false and the dot would stay dark.
  const missing = rows[4];
  expect(missing.times).toBeNull();
  expect(missing.isUnverified).toBe(false);
  // No rate set stays null all the way to the cell — unknown pay renders blank, not $0.00.
  expect(missing.rateCents).toBeNull();
  expect(missing.basePayCents).toBeNull();
  // An invited member who never signed in has no name; the email is the fallback.
  expect(missing.label).toBe('bo@example.com');

  // The page's only arithmetic: the range total is exactly the per-day totals added up.
  const total = rows.at(-1)!;
  expect(total.minutes).toBe(453 + 0 + 120);
  expect(total.basePayCents).toBe(9060 + 0 + 0);
  expect(total.tipShareCents).toBe(5000 + 0 + 0);
  expect(total.totalCents).toBe(14060 + 0 + 0);
  expect(total.label).toBe('Range total · Sun, Mar 15 – Tue, Mar 17');
});

test('a range with no days has no total row to add up', () => {
  expect(buildRows(report([], []), NY, '2026-03-15', '2026-03-21')).toEqual([]);
});
