# Phase 5: Background Pings & Polish

## Context

Design: `docs/design.md` §5.4 (background pings — platform truths), §4.5 (ping validation/flags), §6.2 (badges).

Deliverable: on-shift background location pings every ~10 min (started at clock-in, stopped at clock-out), employer-side "last seen" surfacing, and cross-app polish (empty/error states). Backend ping endpoint + speed flags already exist (phase 2 task 5.4).

**Dependencies**: Phases 3 + 4. Backend changes here are small (one field); mobile is the bulk.

## Tasks

- [ ] Task 1: Mobile background tracking
  - [ ] 1.1: `src/location/tracking.ts` (TaskManager task + start/stop)
  - [ ] 1.2: Background permission flow at first employer clock-in
  - [ ] 1.3: Lifecycle edge cases
- [ ] Task 2: Backend last-seen
  - [ ] 2.1: `last_ping_at` on entries + employer payloads
- [ ] Task 3: Employer surfacing (web)
  - [ ] 3.1: Live "last seen" on open entries + flag legend
- [ ] Task 4: Polish
  - [ ] 4.1: Mobile empty/error/loading states
  - [ ] 4.2: Web empty/error/loading states
- [ ] Task 5: Verification

## Implementation Details

### Task 1: Mobile background tracking

#### 1.1: tracking.ts

**File**: `mobile/src/location/tracking.ts` (replaces phase-3 stubs)

```ts
const SHIFT_TASK = "clockit-shift-tracking";

TaskManager.defineTask(SHIFT_TASK, ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  useOutbox.getState().enqueue({
    kind: "pings", clientId: Crypto.randomUUID(), queuedAt: new Date().toISOString(),
    body: { pings: locations.map(l => ({ at: new Date(l.timestamp).toISOString(),
      loc: { lat: l.coords.latitude, lng: l.coords.longitude, accuracy: l.coords.accuracy ?? 9999 } })) },
  });
  void useOutbox.getState().flush();
});

export async function onClockedIn() {
  if ((await Location.getBackgroundPermissionsAsync()).status !== "granted") return; // fg-only shift, fine
  if (await Location.hasStartedLocationUpdatesAsync(SHIFT_TASK)) return;
  await Location.startLocationUpdatesAsync(SHIFT_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 600_000,            // Android cadence
    deferredUpdatesInterval: 600_000, // iOS batching
    showsBackgroundLocationIndicator: true,
    foregroundService: { notificationTitle: "On shift",
      notificationBody: "ClockIt is recording your shift location", killServiceOnDestroy: false },
  });
}

export async function onClockedOut() {
  if (await Location.hasStartedLocationUpdatesAsync(SHIFT_TASK)) await Location.stopLocationUpdatesAsync(SHIFT_TASK);
}
```

The task file must be imported from the app entry (`app/_layout.tsx`) so it registers headlessly. Verify option names against the installed expo-location version.

#### 1.2: Permission flow

At first **employer** clock-in success (not personal — minimum data): if background permission never asked → modal explaining on-shift tracking ("Your employer sees shift status, not a live map") → `Location.requestBackgroundPermissionsAsync()` (on Android this routes to settings for "Allow all the time"). Denied → shift proceeds foreground-only, one-time info toast; never nag again (persisted flag in session store `ui` slice).

#### 1.3: Edge cases

- App relaunch with open entry (`hydrateFromServer` finds one) → call `onClockedIn()` (idempotent via `hasStartedLocationUpdatesAsync`) — covers iOS force-quit relaunch (iOS won't relaunch the app itself for standard updates; accepted, design §5.4).
- Sign-out and clock-out both stop the task. Defensive stop on launch when there is **no** open entry.
- Server clock-out via another device: next `hydrateFromServer` sees no open entry → stop task.

### Task 2: Backend last-seen

**Files**: `backend/internal/entry/store.go`, `handler.go`

On accepted pings batch: `$set: {last_ping_at: <max at>}` on the open entry. Include `last_ping_at` in the employer entries payload (`GET /v1/employers/{id}/entries`) and entry detail. No coordinates exposed (design: verdicts, not tracks).

### Task 3: Employer surfacing

**Files**: `web/src/components/EntryBar.tsx`, `web/src/routes/calendar.tsx`, `web/src/routes/table.tsx`

Open-entry bar/popover: "On shift · last seen 12 min ago" (from `last_ping_at`; > 25 min → gray "no recent signal" — one missed interval + slack, not an accusation). Calendar auto-refetches every 60 s when the visible week includes today. Table + calendar popover: `speed_anomaly` flag chip with tooltip "Movement between pings exceeded plausibility checks". Add a one-line legend under the calendar (verified/dashed/flagged).

### Task 4: Polish

#### 4.1: Mobile

Empty states: History ("No shifts yet — clock in to get started"), memberships in Profile ("No employers yet — ask your employer to add {email}"). Global error toast component for `ApiError` (single implementation, used by all screens). Skeleton rows for History initial load. App icon + splash in brand blue (`app.json` assets).

#### 4.2: Web

Astryx empty states for calendar/table/employees (with the relevant CTA), error banner with retry on every route's fetch failure, skeletons for table/calendar. Favicon + document titles per route ("Calendar — ClockIt").

### Task 5: Verification

- [ ] 5.1: Android device, real shift ≥ 30 min backgrounded → ≥ 2 ping batches server-side; entry `last_ping_at` advances; web shows "last seen".
- [ ] 5.2: iOS device: pings arrive (possibly batched/deferred); force-quit → no pings (expected); reopen → tracking resumes while entry still open.
- [ ] 5.3: Clock-out stops the OS location indicator on both platforms within seconds.
- [ ] 5.4: Denying background permission still allows full clock-in/out; no repeat prompts.
- [ ] 5.5: Simulated teleport between pings (emulator) → `speed_anomaly` flag visible in web popover.
- [ ] 5.6: `make test`, mobile `tsc`, web `tsc` + build all clean.
