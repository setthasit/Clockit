// Wire shapes returned by the backend. Times are UTC ISO-8601 strings and the
// employer's IANA timezone decides day boundaries — see lib/format.ts.

export interface Employer {
  id: string;
  name: string;
  anchor: {lat: number; lng: number};
  timezone: string;
  created_at: string;
}

export type MemberStatus = 'invited' | 'active' | 'removed';

// A type alias, not an interface: Astryx's Table needs `T extends Record<string, unknown>`,
// and only type aliases get TypeScript's implicit index signature.
export type Member = {
  id: string;
  /** null until the invited address signs in and claims the membership. */
  user_id: string | null;
  email: string;
  status: MemberStatus;
  /** "" while the invitation is unclaimed — there is no user to take a name from yet. */
  name: string;
  /** Employer-only data: never render or log this outside employer-owned views. */
  hourly_rate_cents: number | null;
};

export type EntryStatus = 'open' | 'closed';

/** A shift as the employer sees it. No coordinates by design — only the verdict. */
export interface EmployerEntry {
  id: string;
  user: {id: string; name: string; email: string};
  status: EntryStatus;
  clock_in_at: string;
  /** null while the shift is open. */
  clock_out_at: string | null;
  /** Server-computed and rounded to the minute; null while open. Bar geometry comes
   * from the two timestamps instead, so a bar never disagrees with its own label. */
  duration_minutes: number | null;
  location_verified: boolean;
  /** Never null; [] when clean. Only value today: "speed_anomaly". */
  flags: string[];
}
