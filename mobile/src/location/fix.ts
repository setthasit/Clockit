import * as Location from 'expo-location';

import type {Fix, LatLng} from '@/api/types';

// Both constants mirror backend/internal/entry/geo.go. A client that measures differently
// from the server promises "in range" and then gets an OUT_OF_RANGE rejection.
const EARTH_RADIUS_M = 6371000;

// ponytail: this is the default of the one deployment-wide ANCHOR_RADIUS_M (config.go) — an
// employer has no radius of its own. Ceiling: change that env var and every client badge is
// wrong until an app release ships (the server still decides). Upgrade: the rejection already
// carries the real limit in OUT_OF_RANGE.details.limit_m, so learn it from a refusal.
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
 * reads ApiError.status. `code` is for the caller to branch on without matching copy — the two
 * cases want different affordances (deep-link to Settings vs retry), which the clock screen
 * will decide; the server error map has no location entries.
 */
export class LocationError extends Error {
  code: 'LOCATION_UNAVAILABLE' | 'LOCATION_TIMEOUT';

  constructor(code: LocationError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'LocationError';
    this.code = code;
    // Assigned rather than passed to super: Hermes documents everything post-ES6 outside its
    // supported list as excluded, and error cause is ES2022, so the option can be dropped.
    this.cause = cause;
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
    // coarser fallback fix. Add getLastKnownPositionAsync if timeouts turn out to be common,
    // with a maxAge well under the server's MAX_CLOCK_SKEW (5m): its timestamp is when the fix
    // was taken and lands in `at`, so an older one comes back STALE_TIMESTAMP.
    const p = await Promise.race([
      Location.getCurrentPositionAsync({
        // ponytail: Highest is one step below BestForNavigation against a library default of
        // Balanced, and the clock screen's badge runs a full GNSS session on it every 15 s while
        // focused. Kept anyway: Balanced is ~100 m, exactly the server's MAX_ACCURACY_M, so a
        // badge polling at a coarser accuracy would predict against a different fix than the one
        // task 6.4 sends and the server judges. Ceiling: battery on a screen left open. Upgrade:
        // an optional accuracy argument here defaulted to Highest, if device measurement ever
        // shows the drain is real.
        accuracy: Location.Accuracy.Highest,
        // Android otherwise opens a system settings dialog and waits for the user before it
        // even asks for a location, putting reading time inside the 15 s below.
        mayShowUserSettingsDialog: false,
      }),
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
    // Permission denied, location services off, and — on iOS, where requestLocation() fails
    // fast instead of hanging until the timeout — simply not getting a fix indoors all reject
    // here with native messages that are not showable copy, so one message covers all three.
    // The original rides along as `cause` for logs; only `message` is rendered.
    throw new LocationError(
      'LOCATION_UNAVAILABLE',
      'Could not get your location. Check that location services and permission are on, and try moving outside or near a window.',
      e,
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
