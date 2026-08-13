import {expect, test} from 'vitest';
import {AUTH_PARAMS_RE} from './auth';

test('AUTH_PARAMS_RE strips every search the SDK would re-read as a callback', () => {
  // hasAuthParams() is (code|connect_code|error) && state, so these three shapes are the
  // whole set that can raise "Invalid state" on a reload.
  expect(AUTH_PARAMS_RE.test('?code=abc123&state=xyz')).toBe(true);
  expect(AUTH_PARAMS_RE.test('?error=access_denied&state=xyz')).toBe(true);
  // connect_code is unnamed but caught through its mandatory companion, ?state=.
  expect(AUTH_PARAMS_RE.test('?connect_code=abc123&state=xyz')).toBe(true);
});

test('AUTH_PARAMS_RE keeps the app own search params', () => {
  // The only deep link this app builds.
  expect(AUTH_PARAMS_RE.test('?from=2026-08-09&to=2026-08-09')).toBe(false);

  // Dropping the [?&] anchor would match inside a value and silently truncate these.
  expect(AUTH_PARAMS_RE.test('?q=state')).toBe(false);
  expect(AUTH_PARAMS_RE.test('?filter=state&x=1')).toBe(false);
  expect(AUTH_PARAMS_RE.test('?name=error')).toBe(false);
  expect(AUTH_PARAMS_RE.test('?to=state')).toBe(false);

  // Nor is the name a prefix match: only a param that *is* code/state/error counts.
  expect(AUTH_PARAMS_RE.test('?statement=1')).toBe(false);
  expect(AUTH_PARAMS_RE.test('?errors=1')).toBe(false);
});
