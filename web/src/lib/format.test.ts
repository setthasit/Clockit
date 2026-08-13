import {expect, test} from 'vitest';
import {cents, dayLabel, minutesToHM, timeRange} from './format';

test('cents renders integer cents as dollars', () => {
  expect(cents(1800)).toBe('$18.00');
  expect(cents(0)).toBe('$0.00');
  expect(cents(5)).toBe('$0.05');
  expect(cents(-1800)).toBe('-$18.00');
  expect(cents(1800.6)).toBe('$18.01');
  expect(cents(Number.NaN)).toBe('$0.00');
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
});

test('dayLabel uses the employer timezone for instants and keeps report day keys intact', () => {
  // 01:30 UTC is still the 14th in New York — the employer's zone decides the day.
  expect(dayLabel('2026-03-15T01:30:00Z', 'America/New_York')).toBe('Sat, Mar 14');
  expect(dayLabel('2026-03-15T01:30:00Z', 'Asia/Tokyo')).toBe('Sun, Mar 15');

  // A YYYY-MM-DD report key is a calendar date and must never shift.
  expect(dayLabel('2026-03-15', 'America/New_York')).toBe('Sun, Mar 15');
});
