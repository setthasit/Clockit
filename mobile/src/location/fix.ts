import * as Location from 'expo-location';

import type {Fix, LatLng} from '@/api/types';

// Both constants mirror backend/internal/entry/geo.go. A client that measures differently
// from the server promises "in range" and then gets an OUT_OF_RANGE rejection.
const EARTH_RADIUS_M = 6371000;

// ponytail: the server's radius is configurable (ANCHOR_RADIUS_M, default 1000) but is not
// on the wire, so this copy is the default. Ceiling: an employer with a custom radius gets a
// wrong badge (the server still decides). Upgrade: return it on /v1/me's employer and use it.
const ANCHOR_RADIUS_M = 1000;

// coords.accuracy is null when the platform reports no uncertainty radius. 9999 is not
// "unknown", it is "worse than the server's MAX_ACCURACY_M (100)": such a fix is meant to be
// rejected LOW_ACCURACY rather than accepted as if it had been precise.
const UNKNOWN_ACCURACY_M = 9999;

// LocationOptions has no timeout in expo-location 57, and Accuracy.Highest keeps trying for a
// long time indoors while the user watches a spinner on the clock button.
const FIX_TIMEOUT_MS = 15_000;

/**
 * Deliberately not an ApiError: nothing here came from the server, and the outbox's retry rule
 * reads ApiError.status. `code` matches how the clock screen already maps errors to user copy.
 */
export class LocationError extends Error {
  code: 'LOCATION_UNAVAILABLE' | 'LOCATION_TIMEOUT';

  constructor(code: LocationError['code'], message: string) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
  }
}

/** One GPS reading for a clock event. Requires foreground permission to already be granted. */
export async function getFix(): Promise<Fix> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new LocationError(
            'LOCATION_TIMEOUT',
            'Could not get a GPS fix. Try moving outside or near a window.',
          ),
        ),
      FIX_TIMEOUT_MS,
    );
  });

  try {
    // ponytail: losing the race only rejects — the native request runs on, and there is no
    // coarser fallback fix. Add getLastKnownPositionAsync if timeouts turn out to be common.
    const p = await Promise.race([
      Location.getCurrentPositionAsync({accuracy: Location.Accuracy.Highest}),
      timeout,
    ]);
    return {
      lat: p.coords.latitude,
      lng: p.coords.longitude,
      accuracy: p.coords.accuracy ?? UNKNOWN_ACCURACY_M,
      at: new Date(p.timestamp).toISOString(),
      // Android-only, undefined on iOS — which is why the server also judges accuracy,
      // staleness and speed rather than trusting this flag to catch spoofing.
      mocked: p.mocked ?? false,
    };
  } catch (e) {
    if (e instanceof LocationError) throw e;
    // Permission denied and location services off both reject here with platform-specific
    // native messages; neither is showable copy, and both need the same thing from the user.
    throw new LocationError(
      'LOCATION_UNAVAILABLE',
      'Location is unavailable. Check that location services and permission are on.',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Haversine metres, mirroring haversineM in backend/internal/entry/geo.go exactly — including
 * the min(1, ...) clamp, which keeps float overshoot on near-antipodal pairs out of asin. */
export function distanceM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = ((b.lat - a.lat) * rad) / 2;
  const dLng = ((b.lng - a.lng) * rad) / 2;
  const h =
    Math.sin(dLat) * Math.sin(dLat) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng) * Math.sin(dLng);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * UX pre-check only — the server re-validates. Exported rather than left to each screen because
 * the whole-metre rounding is the server's rule (WithinAnchor), not a display choice: a fix
 * 1000.3 m out is accepted, and two screens rounding differently would disagree with the server.
 */
export function inRange(loc: LatLng, anchor: LatLng): boolean {
  return Math.round(distanceM(loc, anchor)) <= ANCHOR_RADIUS_M;
}
