// Types shared by more than one api/ module or by code outside api/.
// Single-consumer types live beside their endpoint file.

export type LatLng = {
  lat: number;
  lng: number;
};

/**
 * One GPS reading, as produced by location/fix.ts (task 4.1) and consumed by the
 * clock endpoints and the outbox.
 *
 * `at` is a UTC ISO-8601 string, not a Date: a fix is queued in AsyncStorage by the
 * offline outbox and goes on the wire unchanged, so keeping it a string means it
 * survives JSON round-trips without a revive step.
 */
export type Fix = {
  lat: number;
  lng: number;
  accuracy: number;
  at: string;
  mocked: boolean;
};
