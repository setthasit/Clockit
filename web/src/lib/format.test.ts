import {expect, test} from 'vitest';
import {cents, dayLabel, minutesToHM, timeRange, toCents} from './format';

test('cents renders integer cents as dollars', () => {
  expect(cents(1800)).toBe('$18.00');
  expect(cents(0)).toBe('$0.00');
  expect(cents(5)).toBe('$0.05');
  expect(cents(-1800)).toBe('-$18.00');
  expect(cents(1800.6)).toBe('$18.01');
  expect(cents(Number.NaN)).toBe('$0.00');
});

test('toCents converts dollars without losing a penny to float error', () => {
  expect(toCents(18)).toBe(1800);
  expect(toCents(0)).toBe(0);
  expect(toCents(0.05)).toBe(5);

  // 18.07 * 100 is 1806.9999999999998 and 5.29 * 100 is 528.9999999999999: truncating
  // either would underpay by a cent.
  expect(toCents(18.07)).toBe(1807);
  expect(toCents(5.29)).toBe(529);

  // Half a cent rounds up, and the sign survives the trip.
  expect(toCents(0.005)).toBe(1);
  expect(toCents(-0.01)).toBe(-1);

  // The backend caps rates at 100_000_000 cents; the ceiling itself must convert exactly.
  expect(toCents(1_000_000)).toBe(100_000_000);
  expect(toCents(999_999.99)).toBe(99_999_999);

  // Math.round returns -0 just below zero. Not special-cased because it never reaches
  // the backend as one — asserted on the wire form, since -0 is not 0 to Object.is.
  expect(JSON.stringify({hourly_rate_cents: toCents(-0.004)})).toBe('{"hourly_rate_cents":0}');

  expect(toCents(Number.NaN)).toBeNull();
  expect(toCents(Number.POSITIVE_INFINITY)).toBeNull();

  // What the user typed is what the table renders back.
  expect(cents(toCents(18.07) ?? 0)).toBe('$18.07');
});

test('minutesToHM renders h:mm', () => {
  expect(minutesToHM(440)).toBe('7:20');
  expect(minutesToHM(0)).toBe('0:00');
  expect(minutesToHM(60)).toBe('1:00');
  expect(minutesToHM(-5)).toBe('0:00');
});

test('times render in the employer timezone, not the machine zone', () => {
  const clockIn = '2026-03-15T13:02:00Z';
  const clockOut = '2026-03-15T21:35:00Z';

  expect(timeRange(clockIn, clockOut, 'America/New_York')).toBe('9:02–17:35');
  expect(timeRange(clockIn, clockOut, 'Asia/Tokyo')).toBe('22:02–6:35');
  expect(timeRange(clockIn, null, 'America/New_York')).toBe('9:02–now');

  // An unparseable clock-out is not an open shift: it must not render as "now".
  expect(timeRange(clockIn, 'not-a-timestamp', 'America/New_York')).toBe('9:02–—');
});

test('dayLabel uses the employer timezone for instants and keeps report day keys intact', () => {
  // 01:30 UTC is still the 14th in New York — the employer's zone decides the day.
  expect(dayLabel('2026-03-15T01:30:00Z', 'America/New_York')).toBe('Sat, Mar 14');
  expect(dayLabel('2026-03-15T01:30:00Z', 'Asia/Tokyo')).toBe('Sun, Mar 15');

  // A YYYY-MM-DD report key is a calendar date and must never shift — not in a zone
  // behind UTC that would roll it back, nor in one ahead that would roll it forward.
  expect(dayLabel('2026-03-15', 'America/New_York')).toBe('Sun, Mar 15');
  expect(dayLabel('2026-03-15', 'Asia/Tokyo')).toBe('Sun, Mar 15');
});
