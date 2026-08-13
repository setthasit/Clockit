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
