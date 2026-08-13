// Wire shapes returned by the backend. Times are UTC ISO-8601 strings and the
// employer's IANA timezone decides day boundaries — see lib/format.ts.

export interface Employer {
  id: string;
  name: string;
  anchor: {lat: number; lng: number};
  timezone: string;
  created_at: string;
}
