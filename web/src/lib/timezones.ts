const IANA_TIMEZONES = Intl.supportedValuesOf('timeZone');

/**
 * The IANA zone list with `current` guaranteed present.
 *
 * Some browsers resolve — and the backend accepts, since Go's time.LoadLocation does — a
 * non-canonical alias ("Asia/Calcutta") that supportedValuesOf() omits. An employer can
 * therefore already be saved on a zone missing from the list, and all a missing one costs
 * is a Selector that opens blank on the value it is set to.
 */
export function timezoneOptions(current: string): string[] {
  return IANA_TIMEZONES.includes(current) ? IANA_TIMEZONES : [current, ...IANA_TIMEZONES];
}
