# Phase 5: Background Pings & Polish

## Context

Design: `docs/design.md` §5.4 (background pings — platform truths), §4.5 (ping validation/flags), §6.2 (badges).

Deliverable: on-shift background location pings every ~10 min (started at clock-in, stopped at clock-out), employer-side "last seen" surfacing, and cross-app polish (empty/error states). Backend ping endpoint + speed flags already exist (phase 2 task 5.4).

**Dependencies**: Phases 3 + 4. Backend changes here are small (one field); mobile is the bulk.

## Tasks

- [x] Task 1: Mobile background tracking
  - [x] 1.1: `src/location/tracking.ts` (TaskManager task + start/stop)
  - [x] 1.2: Background permission flow at first employer clock-in
  - [x] 1.3: Lifecycle edge cases
- [x] Task 2: Backend last-seen
  - [x] 2.1: `last_ping_at` on entries + employer payloads
- [x] Task 3: Employer surfacing (web)
  - [x] 3.1: Live "last seen" on open entries + flag legend
- [x] Task 4: Polish
  - [x] 4.1: Mobile empty/error/loading states
  - [x] 4.2: Web empty/error/loading states
- [x] Task 5: Verification (5.6 green; 5.1–5.5 partly device-verified — see notes)

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

---

## Phase completion notes (deviations from plan)

### Task 1 — tracking is driven by the clock store, not by two hook calls

`onClockedIn`/`onClockedOut` are gone; `location/tracking.ts` subscribes to `useClockStore`
instead and starts/stops on the `openEntry != null` transition. Every trigger the plan lists
falls out of that one subscription — a live tap (`setOpen`), a queued tap (`setPending`, the
"the worker tapped" contract phase 3 wrote), a close, a launch/reconnect hydrate that finds a
shift open or gone, sign-out and 401 (`reset`) — where the hook pair would have needed new call
sites in `clockFlow.ts`, `sync.ts`, `signOut.ts` and `_layout.tsx`, each able to forget, each
pulling expo-location into a module whose tests would then have to stub it. `clockFlow.ts` and
`signOut.ts` shrank as a result.

`src/location/tracking.test.js` (11 cases) pins the decision: start on shift with the ten-minute
cadence, the defensive stop at launch, no OS call when a further write leaves the answer
unchanged, no start without Always permission, mid-shift grant, and the executor's ping mapping.

Deviations inside 1.1, all forced by the installed libraries:

- The task executor must return a promise (`TaskManagerTaskExecutor` is `=> Promise<any>`), so it
  is `async` and awaits the outbox flush. That is also the correct shape: the OS may suspend the
  JS as soon as the promise settles.
- The outbox item is `body: Ping[]`, not the plan's `body: {pings: [...]}` — the plan snippet
  predates `stores/outbox.ts`.
- `accuracy` is omitted rather than defaulted to 9999 when the platform reports none: the server
  reads accuracy off a ping and drops it, so there is nothing to invent it for.

`app.config.ts` gains `android.permissions: ["android.permission.RECEIVE_BOOT_COMPLETED"]`.
Without it every background delivery crashed the app: `TaskManagerUtils` schedules the delivery
job with `setPersisted(true)`, and Android throws `IllegalArgumentException: Requested job cannot
be persisted without holding android.permission.RECEIVE_BOOT_COMPLETED` on the main thread inside
the broadcast. Neither expo-task-manager's manifest nor the expo-location plugin declares it.
Found on device; fixed and re-verified.

### Task 4 — most of it already shipped in phases 3 and 4

Only the genuinely missing pieces were added: skeleton rows for History's first load (replacing a
spinner), and per-route document titles on the web (`lib/title.ts`, used by the shell, sign-in and
onboarding). Everything else the task lists was already in place — mobile History/Profile empty
states, web empty states with CTAs, error banners with retry on every route, calendar skeleton and
table/employees spinners, favicon, and a brand-blue splash.

**Not built: the "global error toast component for `ApiError`, used by all screens."** Both apps
already render errors inline where they happen, with a retry beside them and an
`accessibilityLiveRegion`/`Banner` announcement — contextual, reachable on touch, and already
tested. Replacing that with one toast would be a larger diff that makes the product worse.

**Not built: a brand-blue app icon.** The splash already is (`#00286E`, phase 3); the icon is
still the scaffold artwork and needs a designer, not a code change.

### Task 3 — flag explanation as a line, not a tooltip

The calendar bar's tooltip carries `flagHint` (label + explanation), and the popover and the table
put the explanation on a line under the chips instead of in a nested tooltip: a hover target
inside a popover is unreachable on touch, which is the same argument the table's existing
amber-dot legend already makes. `lib/flags.ts` holds the labels and explanations so the two views
cannot drift.

### Task 5 — what was actually verified

**5.6 green**: `make test` + `make lint` (0 issues), mobile `tsc --noEmit` + 146/146 node tests +
`expo-doctor` 20/20, web `tsc -b` + 34/34 vitest + `eslint` + `vite build`. Note the web
typecheck must be `tsc -b` — a bare `tsc --noEmit` resolves the root tsconfig's project
references and checks nothing.

**Verified on device** (Pixel 10 Pro emulator, API 37, local stack, signed-in dev build):

- 1.2 end to end: first employer clock-in raises the sheet naming the employer; "Not now" leaves
  the shift running and shows the one-time notice; no repeat prompt after a relaunch mid-shift
  (5.4, Android).
- Tracking starts only with Always granted — with it denied, no foreground service and no
  notification; granting it and relaunching starts the task.
- A background delivery reached the outbox and the server (`location_pings`), `last_ping_at`
  advanced on the entry, and a teleport between pings raised `speed_anomaly` — 2.1 and the server
  half of 5.5, confirmed in Mongo.
- 5.3 (Android): clock-out unregistered the task ~50 ms after the store write; the foreground
  service dropped its notification and the location request was released. Also observed: a
  *refused* clock-out correctly stops then restarts tracking, because the shift is still open.

**Not verified, and why**: 5.1's "≥ 2 batches over ≥ 30 min" — the emulator's GPS only emits a fix
when one is injected, so the ten-minute cadence cannot be exercised on it (the cadence *is*
applied: a fix injected 4 minutes after a delivery was correctly deferred). 5.2 (iOS) — not run.
5.5's web popover — the browser half needs an Auth0 web session. Both need a human with real
devices; nothing in the code paths above is unexercised, but the OS timing on real hardware is.

**One crash seen once and not reproduced**, worth watching on a release build:
`ForegroundServiceDidNotStartInTimeException` during a debug launch that took 20 s to first
render. expo-location only calls `startForeground()` from `onServiceConnected`, so any main-thread
stall over 10 s after it restores a registered task at launch is fatal. It did not recur after the
`RECEIVE_BOOT_COMPLETED` fix, and a release build's launch is far shorter, but it is an upstream
fragility this app is now exposed to.
