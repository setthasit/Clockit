const toDate = (dt: string | Date) => (dt instanceof Date ? dt : new Date(dt));

export function formatClock(dt: string | Date): string {
  return toDate(dt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatDistance(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

// Local calendar day, not UTC: a 23:30 shift must group under the day the
// employee worked it, which toISOString() would push to tomorrow.
// ponytail: groups by *device* timezone, but design §11 makes the employer
// timezone authoritative — an employee travelling across zones sees shifts on
// the wrong day. Upgrade: take the employer IANA tz and format with
// Intl.DateTimeFormat({ timeZone }) when history can span timezones.
export function dayKey(dt: string | Date): string {
  const d = toDate(dt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
