import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type {Ping} from '@/api/entries';
import {theme} from '@/lib/theme';
import {useClockStore} from '@/stores/clock';
import {useOutboxStore} from '@/stores/outbox';

/**
 * On-shift breadcrumbs: started at clock-in, stopped at clock-out, never in between (design
 * §5.4 — do not track people who are not working).
 *
 * Two module-scope side effects, both of which must run before anything can happen: the task
 * registration below, and the clock-store subscription at the bottom. Nothing imports this file
 * for a value, so **app/_layout.tsx imports it for its side effects** — delete that import and
 * tracking silently never starts.
 */

/** The registration name. Stable across releases: the OS holds a running task by this string,
 * so renaming it would orphan a service on every phone mid-shift. */
export const SHIFT_TASK = 'clockit-shift-tracking';

// Design §5.4's ten minutes. Android honours it as a cadence; iOS has no exact timers and reads
// it as a batching floor (deferredUpdatesInterval), so deliveries there arrive late and in
// clumps. Both are fine: a ping is supplementary evidence, the clock events are the record.
const PING_INTERVAL_MS = 600_000;

/**
 * Delivery from the OS, foreground or headless. It may carry several fixes at once (iOS defers
 * and batches), which is why the outbox item is a batch rather than a point.
 *
 * Nothing here decides whether the pings are wanted: the task only runs while it is started,
 * and a batch that arrives after the shift closed is dropped by the server (accepted:0). The
 * outbox owns the retry, so a flush with no signal costs nothing and loses nothing.
 */
TaskManager.defineTask<{locations: Location.LocationObject[]}>(SHIFT_TASK, async ({data, error}) => {
  // `error` is the OS refusing the update (permission revoked mid-shift, location off). There
  // is no screen here to show it on and nothing to queue, so the delivery is simply skipped —
  // the next one either arrives or does not.
  if (error || !data?.locations?.length) return;

  const pings: Ping[] = data.locations.map((l) => ({
    at: new Date(l.timestamp).toISOString(),
    // Omitted rather than faked when the platform reports none: the server reads accuracy off a
    // ping and drops it (entry/handler.go pingBody), so inventing a number would only be a
    // number invented. Unlike a clock fix, where accuracy is a rule.
    loc: {
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      accuracy: l.coords.accuracy ?? undefined,
    },
  }));

  useOutboxStore.getState().enqueue({
    kind: 'pings',
    clientId: Crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
    body: pings,
  });
  // Awaited, which is why this executor is async: expo-task-manager resolves the delivery only
  // when the returned promise settles, and the OS may suspend the JS the moment it does — so
  // returning early would cut the request off mid-flight. Rejection is swallowed because there
  // is no screen to show it on and the batch is already persisted for the next flush.
  await useOutboxStore
    .getState()
    .flush()
    .catch(() => {});
});

async function start(): Promise<void> {
  // A foreground-only shift is a supported shift, not a failure: the worker declined Always
  // (or has not been asked yet), the clock events still record their hours, and the employer
  // sees no "last seen". Never requests here — a prompt raised from a store subscription would
  // fire with no explanation on screen. app/(tabs)/index.tsx owns the ask.
  const {status} = await Location.getBackgroundPermissionsAsync();
  if (status !== Location.PermissionStatus.GRANTED) return;
  if (await Location.hasStartedLocationUpdatesAsync(SHIFT_TASK)) return;

  await Location.startLocationUpdatesAsync(SHIFT_TASK, {
    // Balanced, not the clock screen's Highest: a breadcrumb answers "roughly where, roughly
    // when" for ten hours of a shift, and a GNSS session every ten minutes for that is battery
    // the worker pays for. The server judges pings on speed alone, which ~100 m does not move.
    accuracy: Location.Accuracy.Balanced,
    timeInterval: PING_INTERVAL_MS,
    deferredUpdatesInterval: PING_INTERVAL_MS,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'On shift',
      notificationBody: 'ClockIt is recording your shift location',
      notificationColor: theme.brand,
      // The service outlives a swipe-away, which is the point: an Android worker who clears the
      // app from recents mid-shift is not clocking out, and the notification stays up saying so.
      killServiceOnDestroy: false,
    },
  });
}

async function stop(): Promise<void> {
  // Guarded because stopping an unstarted task throws (`Location updates have not been started`),
  // and this runs on every launch that finds no open shift.
  if (await Location.hasStartedLocationUpdatesAsync(SHIFT_TASK)) {
    await Location.stopLocationUpdatesAsync(SHIFT_TASK);
  }
}

/**
 * What the OS should be doing, and the one place that decides it. `null` is "not yet known",
 * which is what makes the first store write of a launch act either way — including the
 * defensive stop when there is no open shift (plan §1.3), for the phone whose foreground
 * service survived a kill and whose shift was closed from another device.
 *
 * Latched before the async work rather than after it, so two transitions in flight cannot both
 * see a stale value. The cost is that a `start()` which throws natively is not retried until
 * the next transition; the permission-declined case is not a throw and is covered by
 * requestShiftTracking() below.
 */
let desired: boolean | null = null;

// Serialized, because start and stop are multi-step and racing them can leave the OS running a
// task this module believes it stopped. A rejection is swallowed rather than left to poison the
// chain — each link is independent.
let queue: Promise<void> = Promise.resolve();

function run(step: () => Promise<void>): void {
  queue = queue.then(step).catch(() => {});
}

/**
 * The single trigger, and why there is no `onClockedIn`/`onClockedOut` pair any more: every way
 * a shift can begin or end is already a write to this store, so subscribing to it covers all of
 * them at once — a live tap (setOpen), a tap with no signal (setPending, the queued path, where
 * "the worker tapped" is the trigger and the server has not answered), a close (setClosed), a
 * launch or reconnect hydrate that finds a shift open or finds it gone, a sign-out and a 401
 * (reset). Call sites in clockFlow.ts, sync.ts, signOut.ts and _layout.tsx would each have had
 * to remember; a subscription cannot forget, and it keeps expo-location out of four modules
 * whose tests would then have to stub it.
 *
 * Compared as a boolean, never by entry identity: every hydrate parses fresh objects, so an
 * identity check would re-ask the OS about a task that never changed.
 *
 * ponytail: a refused clock event churns the OS task for the width of the request, in both
 * directions — a clock-in starts tracking on setPending and stops on the revert, a clock-out
 * stops on setPending(null) and starts again when setOpen puts the shift back. Both observed on
 * a Pixel 10 Pro emulator (a refused clock-out measured stop→start 2.2 s apart), and both are
 * the honest reading of a store that is optimistic by design. Ceiling: an Android notification
 * (and the iOS indicator) that flickers on a refused tap. Deliberately not "wait for the
 * server", which would break the queued path this app is built for. Upgrade path if it reads
 * badly on device: debounce this handler by a second or two, so a refusal that lands inside the
 * window collapses to no OS call at all.
 *
 * ponytail: an offline relaunch mid-shift does not resume tracking, because the launch hydrate
 * rejects and writes nothing, so this never fires. Android usually needs nothing (the
 * foreground service outlived the process); iOS does not relaunch a force-quit app for standard
 * updates either way (design §5.4). Ceiling: a phone that was killed and is still offline pings
 * nothing until the first successful hydrate. Upgrade path: reconcile from the persisted queue
 * instead, once stores/clock.ts persists `openEntry` (its own scheduled upgrade).
 */
useClockStore.subscribe((state) => {
  const onShift = state.openEntry != null;
  if (desired === onShift) return;
  desired = onShift;
  run(onShift ? start : stop);
});

/**
 * Re-checks the OS against a shift already in progress. The subscription above cannot do this:
 * being on shift is exactly the state it has already latched, so nothing it watches changes when
 * the *permission* does.
 *
 * Two callers, both about permission arriving late. On Android 11+ the request below does not
 * raise a dialog at all — it opens the app's settings page — so the answer lands on the way back
 * into the app, not in the promise; the clock screen therefore calls this on foreground. And a
 * worker who grants Always from Settings mid-shift, months after declining, gets tracking with no
 * further tap. Cheap enough to call freely: two native reads and then nothing when already running.
 */
export function syncShiftTracking(): void {
  if (useClockStore.getState().openEntry) run(start);
}

/**
 * Asks for Always location and starts tracking if that is answered here and now.
 *
 * Resolves `false` for a denial, which is a supported outcome and not an error — and on Android
 * 11+ also for "the settings page was opened", where nothing has been decided yet. Rejects only
 * if the native module is unreachable (a web build); the caller decides what to say.
 */
export async function requestShiftTracking(): Promise<boolean> {
  const {status} = await Location.requestBackgroundPermissionsAsync();
  if (status !== Location.PermissionStatus.GRANTED) return false;
  syncShiftTracking();
  return true;
}
