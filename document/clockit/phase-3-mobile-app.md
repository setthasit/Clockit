# Phase 3: Mobile App (Employee)

## Context

Design: `docs/design.md` §5 (structure, UX, offline), §4.2 (API), §4.5 (validation rules → error UX), §11 (decisions).

Deliverable: the full employee app against the local backend — Auth0 sign-in, clock screen with employer sheet + live distance, history with assign-employer, profile, and the offline outbox. Background pings are **phase 5** (only the stub hook points are laid here).

**Dependencies**: Phase 2 (API running at `http://<LAN-IP>:8080`). Runs parallel to phase 4.

Stack: latest stable Expo SDK via `npx create-expo-app` (SDK 54+ required for `@expo/ui`; New Architecture default), TypeScript, expo-router, `@expo/ui` (universal namespace `@expo/ui/universal` by default; per-platform `swift-ui`/`jetpack-compose` only when a universal component is missing) + plain `StyleSheet` for custom views, Zustand (+ `persist` with AsyncStorage), `react-native-auth0` (+ its Expo config plugin), `expo-location`, `@react-native-community/netinfo`, `expo-crypto` (UUIDs). Dev builds via `npx expo run:ios|android` or a dev client — `react-native-auth0` is native code, plain Expo Go will not work.

Rules: no barrel files; components in `src/components` only when reused or >~80 lines; screens own their layout. All money/time formatting helpers in one `src/lib/format.ts`. Accent `#00286E`.

## Tasks

- [ ] Task 1: Project scaffold
  - [x] 1.1: create-expo-app + @expo/ui + theme
  - [x] 1.2: expo-router skeleton + app.json config
- [ ] Task 2: Auth
  - [x] 2.1: Auth0 provider + session store
  - [x] 2.2: Sign-in screen + auth gate (auth half; location branch deferred to 4.2)
- [ ] Task 3: API layer
  - [x] 3.1: `src/api/client.ts` fetch wrapper
  - [x] 3.2: Typed endpoints (`me.ts`, `entries.ts`)
- [ ] Task 4: Location helpers
  - [x] 4.1: `src/location/fix.ts`
  - [x] 4.2: Permissions explainer screen
- [ ] Task 5: Stores
  - [x] 5.1: `session.ts` + `clock.ts`
  - [x] 5.2: `outbox.ts` (persisted queue)
- [ ] Task 6: Clock screen
  - [x] 6.1: Status card + elapsed timer + ClockButton
  - [x] 6.2: DistanceBadge (live pre-check)
  - [x] 6.3: EmployerSheet
  - [x] 6.4: Clock-in/out flow + error mapping
- [ ] Task 7: History & entry detail
  - [x] 7.1: History tab (grouped by day)
  - [x] 7.2: Entry detail + assign employer
- [ ] Task 8: Profile tab
  - [x] 8.1: Profile screen + sign out
- [ ] Task 9: Outbox sync
  - [ ] 9.1: Flush triggers + replay
- [ ] Task 10: Verification (manual checklist)

## Implementation Details

### Task 1: Scaffold

#### 1.1: App + styling

`npx create-expo-app@latest mobile -t` (TypeScript, tabs template acceptable then pruned). `npx expo install @expo/ui`. Theme tokens in `mobile/src/lib/theme.ts`:

```ts
export const theme = { brand: "#00286E", spacing: { s: 8, m: 16, l: 24 }, radius: { m: 12, full: 999 } };
```

Custom views style with plain `StyleSheet` + these tokens. Expo UI components take colors via props/modifiers — no CSS layer.

**File**: `mobile/src/lib/format.ts` — `formatClock(dt)`, `formatDuration(mins)` (`3h 41m`), `formatDistance(m)` (`620 m` / `2.4 km`), `dayKey(dt)`.

#### 1.2: Router + config

**Files**: `mobile/src/app/_layout.tsx`, `mobile/src/app/sign-in.tsx`, `mobile/src/app/permissions.tsx`, `mobile/src/app/(tabs)/_layout.tsx`, `mobile/src/app/(tabs)/index.tsx`, `mobile/src/app/(tabs)/history.tsx`, `mobile/src/app/(tabs)/profile.tsx`, `mobile/src/app/entry/[id].tsx`

`_layout.tsx`: providers (Auth0Provider) + auth gate: no session → redirect `/sign-in`; session but foreground location permission undecided → `/permissions`. Tabs: Clock (default), History, Profile.

`app.json`: `scheme: "clockit"`, `plugins`: `react-native-auth0` plugin (domain from env), `expo-location` plugin with `NSLocationWhenInUseUsageDescription`/`NSLocationAlwaysAndWhenInUseUsageDescription` strings explaining shift validation + on-shift tracking (wording matters for App Store review; background keys land now so phase 5 needs no new native build). API base URL + Auth0 domain/clientId/audience via `app.config.ts` reading `process.env.EXPO_PUBLIC_*`; `.env.example` documents `EXPO_PUBLIC_API_URL=http://192.168.x.x:8080`.

### Task 2: Auth

#### 2.1: Provider + session store

**File**: `mobile/src/stores/session.ts`

```ts
type SessionState = {
  accessToken: string | null;
  me: Me | null;                 // /v1/me payload
  setToken(t: string | null): void;
  loadMe(): Promise<void>;       // GET /v1/me -> set me
  clear(): void;
};
```

Zustand, not persisted (tokens live in the Auth0 SDK's keychain storage; `me` refetches on launch). `react-native-auth0`'s `useAuth0()` handles credential storage/refresh — on app start call `getCredentials()` (silently refreshes) and push the access token into the store; token retrieval for API calls goes through a single `getAccessToken()` helper in this file.

#### 2.2: Sign-in

**File**: `mobile/src/app/sign-in.tsx`

Brand-blue screen, logo, one primary button "Sign in" → `authorize({ audience: EXPO_PUBLIC_AUTH0_AUDIENCE, scope: "openid profile email offline_access" })` (Universal Login shows Google/Apple/Facebook/password — zero in-app credential UI). On success: set token, `loadMe()`, router replace `/(tabs)`. Error → inline message + retry.

### Task 3: API layer

#### 3.1: Client

**File**: `mobile/src/api/client.ts`

```ts
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) { super(message); }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T>
```

Prefixes base URL, attaches `Authorization: Bearer`, JSON in/out, 15 s timeout (AbortController), parses the error contract into `ApiError`; network/timeout → `ApiError(0, "NETWORK", ...)` (the outbox keys on `status === 0 || status >= 500`). 401 → clear session (redirect handled by gate).

#### 3.2: Endpoints

**Files**: `mobile/src/api/me.ts`, `mobile/src/api/entries.ts`

Typed functions matching design §4.2 exactly: `getMe`, `patchMe`, `clockIn(body)`, `clockOut(body)`, `listEntries(from, to)`, `assignEmployer(id, employerId)`, `postPings(pings)`. Types (`Me`, `Membership`, `Entry`, `Fix`) defined beside their endpoint file — shared ones in `mobile/src/api/types.ts`.

### Task 4: Location

#### 4.1: fix.ts

**File**: `mobile/src/location/fix.ts`

```ts
export async function getFix(): Promise<Fix> {
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
  return { lat: p.coords.latitude, lng: p.coords.longitude,
           accuracy: p.coords.accuracy ?? 9999, at: new Date(p.timestamp).toISOString(),
           mocked: p.mocked ?? false }; // Android-only flag; undefined on iOS
}
export function distanceM(a: LatLng, b: LatLng): number // haversine, mirrors backend geo.go
```

#### 4.2: Permissions explainer

**File**: `mobile/src/app/permissions.tsx`

Friendly pre-prompt screen (design §5.2): icon, "ClockIt checks you're at the right place only when you clock in/out, and records your location during shifts." Buttons: "Continue" → `Location.requestForegroundPermissionsAsync()` → route to tabs (background permission is requested in phase 5 at first clock-in, not here — ask only when needed); "Not now" → tabs with clock disabled state. Persist that the explainer was seen (zustand persist, `ui` slice in session store).

### Task 5: Stores

#### 5.1: clock.ts

**File**: `mobile/src/stores/clock.ts`

```ts
type ClockState = {
  openEntry: Entry | null;       // server or optimistic
  pendingSince: string | null;   // set when optimistic (offline)
  setOpen(e: Entry | null): void;
  hydrateFromServer(): Promise<void>; // listEntries(today) -> find status=open
};
```

Elapsed timer is derived in the component (1 s interval from `openEntry.clock_in.at`) — not stored.

#### 5.2: outbox.ts

**File**: `mobile/src/stores/outbox.ts`

```ts
type OutboxItem =
  | { kind: "clock-in";  clientId: string; body: ClockInBody;  queuedAt: string }
  | { kind: "clock-out"; clientId: string; body: ClockOutBody; queuedAt: string }
  | { kind: "pings";     clientId: string; body: PingsBody;    queuedAt: string };

type OutboxState = {
  items: OutboxItem[];
  enqueue(item: OutboxItem): void;
  flush(): Promise<void>;   // FIFO; stop on NETWORK/5xx (retry later); drop item on 4xx but surface: mark entry needs_attention
  needsAttention: { clientId: string; code: string; message: string }[];
};
```

Persisted via `persist` + AsyncStorage (whole store). Flush is serialized (guard flag). 4xx on replayed clock-in/out means the server rejected an offline action — remove from queue, record in `needsAttention`, clock store reverts optimistic state; History shows the banner (7.1).

Classifier constraints found while building 3.1 — the retry rule is `status === 0 || status >= 500 || status === 429`, everything **else** drops:

- **429 must retry.** The backend rate-limits per `sub` per route path at 30/min (`RATE_LIMIT_PER_MIN`), and `/v1/entries/clock-in`, `/clock-out` and `/v1/pings` are all limited. A FIFO flush after a long offline shift bursts past that (pings cap at 64/batch), so treating 429 as permanent would drop real data and raise a spurious "needs attention". Do not remap 429 inside `api()` instead — task 6.4 maps `code` to user copy and would be corrupted.
- **Make the classifier total, not a 4xx/5xx if-chain.** `api()` can throw `ApiError` with a 2xx status (a truncated 200 body → `ApiError(200, "UNKNOWN")`), which no 4xx/5xx branch covers. Dropping is correct there — the server returned 200, the write landed, and a retry would double the clock-in.
- `ApiError(400, "CONFIG")` (missing `EXPO_PUBLIC_API_URL`) is deliberately non-retryable: `EXPO_PUBLIC_*` is inlined at build time, so a build missing it can never start working and would park the queue forever.

**The flush must set `queued: true` on every replayed clock item**, and `ClockInBody`/`ClockOutBody` in `src/api/entries.ts` need that field (added to the backend after this plan was written — see the completion note). Without it the backend rejects anything replayed more than 5 minutes late with `STALE_TIMESTAMP` and the outbox drops it, which is 10.5's acceptance test failing. Send it only for items actually replayed from the queue, never for a live tap: an accepted queued event older than `MAX_CLOCK_SKEW` gets a `backdated` flag on the entry, and flagging every ordinary clock-in would make the flag meaningless to the employer.

A **clock-out** item must also carry the open entry's `client_id` (or entry `id`) alongside its own `clientId`. The server keeps the close idempotency key in a separate `close_client_id` field and never emits it, so `Entry.client_id` is always the *clock-in* id — matching `needsAttention[].clientId` against entry rows in 7.1 would silently never light the amber icon for a rejected clock-out, which is the case a user most needs to see.

### Task 6: Clock screen

**File**: `mobile/src/app/(tabs)/index.tsx` (+ `mobile/src/components/ClockButton.tsx`, `DistanceBadge.tsx`, `EmployerSheet.tsx`)

#### 6.1: Status card + button

Top: card — clocked out: "Clocked out" + last shift summary; clocked in: employer name (or "Personal"), "On shift since 9:02" + live `3h 41m`. Center: 180 pt circular `ClockButton` (brand fill, white label "Clock in" / "Clock out", pressed scale animation, disabled+spinner while a request is in flight). `pendingSince` set → subtle "waiting for connection" pill under the card.

#### 6.2: DistanceBadge

Visible when clocked out and `me.memberships.filter(m => m.status === "active").length > 0`. Poll `getFix()` every 15 s while the screen is focused (foreground permission only). Shows nearest employer: `620 m from Acme Cafe — in range` (green check) or red `2.4 km from Acme Cafe — out of range`. Pure UX pre-check — server still decides.

#### 6.3: EmployerSheet

`BottomSheet` from `@expo/ui/universal` (native sheet, no extra dependency): one row per active membership — name + live distance + disabled style when out of range (still tappable; server gives the authoritative error) — plus divider and "No employer (personal)". Renders only when memberships ≥ 1; zero memberships clock in directly with no popup (design requirement).

#### 6.4: Flow + error mapping

```
tap → (memberships? sheet select : personal) → getFix()
    → local pre-checks: mocked -> alert, skip request; accuracy > 100 -> confirm dialog ("GPS weak — try anyway?")
    → clientId = Crypto.randomUUID()
    → optimistic: clock.setOpen(local entry), pendingSince=now
    → api clockIn → success: replace with server entry, pendingSince=null
                  → ApiError 4xx: revert optimistic, show mapped message
                  → NETWORK/5xx: keep optimistic, outbox.enqueue
```

Error map (code → copy): `MOCKED_LOCATION` "Mock location detected — disable fake GPS apps.", `OUT_OF_RANGE` "You're {distance_m} from {employer} — move within 1 km.", `LOW_ACCURACY` "GPS accuracy too low — step outside and retry.", `STALE_TIMESTAMP` "Device clock looks wrong — check date & time.", `QUEUED_TOO_OLD` "This shift waited too long to sync — ask your employer to add it manually." (only reachable on a replayed clock-in; there is no client-side remedy, so do not offer retry), `OPEN_ENTRY_EXISTS` triggers `hydrateFromServer()`. Clock-out identical shape (no sheet). Phase-5 hook points: `onClockedIn(entry)` / `onClockedOut()` empty functions in `src/location/tracking.ts` created now, called from the flow.

### Task 7: History & detail

#### 7.1: History tab

**File**: `mobile/src/app/(tabs)/history.tsx`

`listEntries(last 30 days)` + pull-to-refresh (`FlatList` + `RefreshControl`, sections by `dayKey`). Row (`src/components/EntryRow.tsx`): employer chip (brand outline; gray "Personal"), `9:02 – 17:35`, duration, open entry → pulsing "on shift", `needsAttention` match → amber warning icon. Top banner when `outbox.items.length > 0`: "N actions waiting to sync". Rows are custom RN (chips/pulse don't map to Expo UI `List`); use Expo UI only if a universal component fits without fighting it.

#### 7.2: Detail + assign

**File**: `mobile/src/app/entry/[id].tsx`

Times, duration, employer, `location_verified` badge (green "Location verified" / amber "Not verified"), flags list. Personal entries: "Assign employer" → `Picker` from `@expo/ui/universal` (active memberships) → `assignEmployer` → refetch → toast; explain resulting badge if unverified ("Outside Acme's zone at clock-in time").

### Task 8: Profile

**File**: `mobile/src/app/(tabs)/profile.tsx`

Name (editable → `patchMe`), email (read-only), memberships list ("Added by Acme Cafe · active"), app version, "Sign out" → Auth0 `clearSession()` + wipe all stores (session/clock/outbox — warn if outbox non-empty: "N unsynced actions will be lost"). Settings-style layout via `@expo/ui/universal` (`FieldGroup`/`List` rows, `TextInput` for name); sign-in screen, ClockButton, DistanceBadge stay custom RN + StyleSheet.

### Task 9: Outbox sync triggers

**File**: `mobile/src/stores/outbox.ts` (+ wiring in `src/app/_layout.tsx`)

Flush on: NetInfo `isConnected` transition to true, AppState → `active`, successful launch after `loadMe()`. After any flush that contained clock items → `clock.hydrateFromServer()` to reconcile.

### Task 10: Verification (manual checklist)

- [ ] 10.1: Fresh install → sign-in via Google and via username/password → lands on Clock.
- [ ] 10.2: Zero-membership user: clock-in has **no popup**; personal entry appears; clock-out > 1 km away (simulator custom location) → `OUT_OF_RANGE` message.
- [ ] 10.3: Seeded member (backend `make seed` with your email): sheet lists employer + distance; in-range clock-in succeeds; out-of-range shows server distance error.
- [ ] 10.4: Android emulator with a mock-location app → clock-in blocked (local + server).
- [ ] 10.5: Airplane mode clock-in → optimistic "waiting" state → disable airplane → auto-sync, entry visible in backend.
- [ ] 10.6: Assign employer on a personal entry → badge reflects verification.
- [ ] 10.7: Sign out clears everything; relaunch requires sign-in.
- [ ] 10.8: `npx tsc --noEmit` and `npx expo-doctor` clean; iOS + Android dev builds run.

### Phase completion notes (deviations from plan)

- 9.1: the triggers live in a new **`src/lib/sync.ts`**, not in `stores/outbox.ts` as the plan names — that store "deliberately knows nothing about the clock store" and the reconcile *is* a clock-store call, so putting it there would make the queue depend on what it is careful not to know, and would pull NetInfo, a native module, into the one file `clockFlow.test.js` and `signOut.test.js` already import. `_layout.tsx` keeps only what the gate has: `useEffect` on the **boolean** `signedIn`, returning `startSync()`'s stop function, since a listener that outlives a session flushes a **device-wide** queue for whoever signs in next. **Not `signedIn && me != null`**: `me` is a profile fetch, not a session check, and the two come apart in the case these triggers exist for — an offline relaunch with a queued shift keeps `signedIn` true (`hasValidCredentials()` is a local keychain read) while `loadMe()` throws NETWORK and the gate parks on Retry with `me` null forever, so no listener was ever armed and signal returning did nothing while the server's `MAX_QUEUED_AGE` ran down. A launch flush against a dead session costs one 401 the queue survives by design, and the gate's own `loadMe` 401 ends that session anyway; a boolean (either way) is also what stops 8.1's name save from tearing the listeners down on an identity change. The launch flush is **once per process**, not once per arrival of `me`: `onUnauthorized()` clears `me` and the gate answers by reloading it, so a flush tied to that closes a loop through a 401 — flush 401s → `me` cleared → `me` reloaded → flush 401s — against an endpoint already refusing us, and the queue survives a 401 by design so AppState/NetInfo replay it anyway. The residual of never resetting the flag is a sign-out and sign-in inside one process: the **deliberate** sign-out empties the queue (`clearForSignOut`), but the **401 exit deliberately keeps it** (`stores/outbox.ts`, `lib/signOut.ts`), so after that pair the launch flush is suppressed until the next foreground or reconnect — bounded, and the loop argument is what buys it. **NetInfo is read as a transition and both halves are load-bearing**: `State.add` hands a brand-new subscriber the latest state *immediately* (`state.ts`), so "is true" would fire a second sync beside the launch one, and only the reachability half dedupes — `_handleNativeStateUpdate` forwards every native event, so a phone hopping cell towers repeats "connected" all day; the flag therefore starts `undefined` (seed, do not act) and fires only on `!== true → true`, which covers the `isConnected: null` unknown state too. **`isConnected`, not `isInternetReachable`**: reachability is a HEAD to `clients3.google.com`, null while in flight, false behind any captive portal or firewall our own API is reachable through, and a request behind a real reconnect — the flush is its own reachability test, since a send that fails is retryable and stays queued. AppState gets a **second** listener rather than reusing `(tabs)/index.tsx`'s: that one is inside a `useFocusEffect` (gone whenever the worker is on History or Profile) and was widened to `!== "background"` for the distance poller, which would fire this on every glance at a notification centre. Whether the flush **contained clock items** is read off queue depth before and after, not from a widened `flush()`: its `Promise<void>` join is pinned by a test comparing the two promises for identity, and depth says the same thing from outside — including for the **drop** path, where an item also leaves and its optimistic entry is exactly what needs reverting. Pings are excluded, because nothing about open/closed changes when breadcrumbs land and `hydrateFromServer()` is the app's most expensive call. The pill obligation `stores/outbox.ts` hands 9.1 is closed with `clock.ts`'s own upgrade path (b) — `setOpen(openEntry)` **only when no clock item remains queued**, so a dead-zone shift whose clock-in is accepted while its close is still owed does not read "on shift, nothing pending" — and only when `pendingSince` is actually set, since `setOpen` bumps the write generation and would void someone else's in-flight hydrate for nothing. Two further conditions on that same clear: **only when the hydrate resolved** (a drain that succeeds followed by a failing `GET /v1/entries` — the heaviest route in the app, fired one second after signal returned — has no server answer to clear the pill against, and on the drop path `clock.ts` keeps the optimistic entry, so the clock tab would say "on shift, nothing pending" about a shift the server permanently refused); and **only when `pendingSince` is the flag the flush started with**, captured before it, because a clock-out tapped while the last queued clock-in drains writes its own flag and clearing that one is the same lie arriving concurrently. The first leaves a marked residual: a failed reconcile leaves the pill up until the next clock action, since a later trigger finds an empty queue and returns at the depth check — the honest residual, but a new ceiling, whose upgrade path is `clock.ts`'s option (a), keying the pill off outbox depth. It is deliberately **not** closed by reconciling whenever `pendingSince != null && after === 0`, which fires inside a live tap's own optimistic window and could take a worker off shift mid-request from a server view predating the tap. Queue depth is read *before* the outbox's `await hydrated` gate, against that file's own warning: exempt only because the launch flush is the sole trigger that can precede rehydration and the clock store is empty at launch (not persisted, and `(tabs)/index.tsx` hydrates on mount regardless), so there is nothing to reconcile — noted in the code so it is not "fixed" later. `sync.ts` carries its own single-flight around flush-plus-reconcile: `flush()` already collapses the *requests*, but each joined caller still resolves and would run its own full-history decrypt, and NetInfo→true with AppState→active is the ordinary unlock-in-a-dead-zone pair. A rejecting `flush()` is swallowed (it rejects only on a non-`ApiError` — a bug in ours — and leaves the item queued; there is no screen here, and rethrowing from a NetInfo callback is an unhandled rejection and nothing else), and the depth comparison still runs afterwards. **No signed-in guard on the reconcile**, deliberately: `lib/signOut.ts` clears the credentials *before* it empties the queue, so a sync in flight across a sign-out finds no token and the request never leaves the device, and `reset()` has bumped the write generation by then — two independent stops, where a third would only cost an import. `history.tsx` was re-checked and still **has nothing called into it**: the flush moves `items.length` (its debounced dependency) and the reconcile moves `openEntry` (a re-render, no fetch), so no second refresh path exists. `src/lib/sync.test.js` drives the real outbox, the real persist and the real clock store against stubbed NetInfo/AppState/AsyncStorage/endpoints — modelling the immediate subscribe callback and the absence of deduping, since a stub that smoothed either over would pass a defect — with send and list ceilings asserted *inside* the responders so a re-firing trigger fails in milliseconds instead of hanging the runner into a cancellation; all ten cases were proved non-vacuous by thirteen mutations (seed removed, repeat filter removed, `active` widened to `!== "background"`, drained-nothing guard removed, pings counted as clock items, last-clock-item guard removed, pill clear removed, hydrate-succeeded guard removed, captured-`pendingSince` guard removed, launch-once guard removed, cleanup removed, reconcile removed, single-flight removed), each red on its intended case by its named assertion and reverted. A mutation also fails the two tests that run after the one it breaks, because a failing assertion skips that test's `stop()` and leaves its listeners armed — noise, not a second finding. **Unverified**: no device and no renderer, so the native NetInfo module never ran (the event shape, the transition timing and `isConnected` on a real airplane-mode toggle are read from `state.ts`, not observed), no real AppState transition was seen, and the gate's effect was never executed — including the offline-relaunch case the `signedIn` dep exists for, which needs a device with a queued shift and no signal. The new native dependency has **no pods installed**: `npx expo prebuild`/`pod install` was not run, and `nativeInterface.ts` throws at *module evaluation* when `NativeModules.RNCNetInfo` is null while `_layout.tsx` imports `@/lib/sync` at module scope — so an existing dev-client binary handed this JS **crashes at launch** until prebuild/pod install, rather than merely lacking the feature. (JS-only checks pass: `tsc`, both `expo export`s, `expo-doctor` 20/20.)
- 8.1: the sign-out sequence lives in **`src/lib/signOut.ts`**, not the screen, for 6.4's reason — every branch is a way to hand one worker's hours to another and none is reachable by hand (they need a cancelled browser dialog, an offline logout, or a request in flight across the wipe); `src/lib/signOut.test.js` drives the real stores, the real persist and the real shipped `WebAuthError`, and each of its five guarantees was proved non-vacuous by mutation. **Order is `clearSession()` → wipe, not the reverse**, and the SDK is why: `Auth0Provider.clearSession` is `webAuth.clearSession()` → `credentialsManager.clearCredentials()` → `LOGOUT_COMPLETE` (`hooks/Auth0Provider.tsx`), so a **cancel rejects before the credentials are touched** and leaves the session wholly intact — wiping first would destroy a queued shift for a sign-out that then did not happen, across a window that is seconds wide because a human is reading a dialog inside it. The residual is a kill between the SDK clearing the keychain and `clearForSignOut()` landing (milliseconds, marked `ponytail:` with the upgrade path: drive `webAuth.clearSession()` and `clearCredentials()` separately off the non-hook client and put the wipe between them). Any **non-cancel** failure falls back to `clearCredentials()`, which is local: `webAuth.clearSession` has to load a logout URL, and refusing to sign out in a dead zone strands a worker handing over a shared phone — the ordinary case this app is for. The invariant across all four branches is **nothing local is wiped unless the credentials are actually gone**, so there is no path ending in an emptied queue behind a live session, nor in a signed-out device whose queue is still on disk for the next person's first flush. **`stores/clock.ts` gained `reset()`** rather than the screen calling `setOpen(null)` plus a `setState` for `lastClosed`: the write generation is module-scope, and without bumping it a `hydrateFromServer()` issued with the previous worker's token lands after the wipe and puts their open shift, and its coordinates, back on someone else's screen. **`stores/ui.ts` is deliberately *not* cleared** — `locationExplainerSeen` is device-scoped and holds nothing about the user, the OS permission behind it is device-wide too (so a new worker meets it already granted or already denied), and clearing it would re-show a blocking screen to a returning worker; 6.1's disabled-clock state is the real recourse. **No `Alert`**: the "N unsynced actions will be lost" line is on screen *before* any tap and the reveal is the confirmation, exactly as 7.2's assign — a dialog that is a no-op on web and stashed-never-shown on a paused Android host is a poor guard for something irreversible. **No "flush first" button** (9.1 owns triggers, and warn-or-flush is what `stores/outbox.ts` asks for), and no `/permissions` link (6.1 already closes that gap at the point of need). Name editing is **not optimistic and never queued**: the outbox's item kinds are a persisted, tested schema for writes that are money and have a deadline, `PATCH /v1/me` carries no `client_id` to dedupe a replay, and an empty/whitespace name is refused locally rather than learned from the server's 400. **Not `@expo/ui`**, against the plan's `FieldGroup`/`List`/`TextInput` — those three do exist in 57.0.10 (under the package's `.` export; still no `universal` specifier, as 6.3 found) and a settings form is what `FieldGroup` is for, but across the whole universal surface `accessibilityLabel` is declared on **exactly one component, `Icon`**: `UniversalBaseProps` has none, `ListItemProps` has none (not even `disabled`), `TextInputProps` has none, Android's `ModifierRegistry` still registers no `contentDescription` (its `semantics` modifier sets autofill `contentType` only), and there is **no progress indicator in the set at all** — so a rejected save, a save in flight and "signing out destroys N unsynced actions" have no carrier, and the RN escape hatch means an `RNHostView` per message. Version comes from `Constants.expoConfig?.version`, not the deprecated `nativeAppVersion` (which now points at `expo-application`, a dependency this app does not have). **Unverified**: no renderer and no device, so nothing about the gate actually flipping was executed — in particular the case `_layout.tsx` documents, where `user` is already `null` (an offline launch whose renew failed) and `LOGOUT_COMPLETE` therefore changes nothing the keychain effect depends on; the reasoned path is that the cleared `me` re-runs the gate's loader, whose 401 reaches the existing `clearCredentials().then(() => setHasCreds(false))`, i.e. a spinner then sign-in rather than a hang, but that is source-reading, not a run.
- 7.2: **no `Picker`** for the employer choice — the same finding as 6.3's, one component over. `@expo/ui`'s universal `PickerProps` is exactly `selectedValue` / `onValueChange` / `appearance` / `enabled` / `children` / `testID`: no `modifiers`, no `label`, no accessibility prop of any kind, so the label has to come from the platform view and on **neither** platform does it. iOS builds its `modifiers` array *internally* (`[pickerStyle(...)]`, plus `disabled(true)`) and never accepts the caller's, so the labelling escape hatch the swift-ui `Picker` does have — `label`, `CommonViewModifierProps` — is unreachable through the wrapper; Android anchors a Material 3 `ExposedDropdownMenuBox` on a `readOnly` `TextField` carrying only `menuAnchor()` and `onVisibilityChanged()`, i.e. an unlabelled text field is the entire accessible surface. On top of that `selectedValue` is **required**, and assignment is one-way from *no* employer — so a picker would have to be seeded with a fabricated pre-selection, putting an employer's name on screen as the current answer for a shift that has none, one tap away from being true. Plain `Pressable` rows behind a reveal instead: the reveal *is* the confirmation step (no `Alert`, for 6.4's reasons), and each row is a labelled button that commits exactly what it says. **No refetch and no toast**, against the plan's "refetch → toast": `PATCH /v1/entries/:id` answers with the assigned entry, recomputed `location_verified` included (`handler.go:572-579`), so the refetch would spend a second full-window server-side decrypt to be told what the response already said, and History reloads on its own focus effect. The assign response therefore also **bumps `loadGen`** — a pull-to-refresh started before the tap resolves after it (one 30-day decrypt against one tiny PATCH) and would otherwise overwrite the assigned entry with its pre-assign snapshot, replacing a recorded `location_verified: false` with the vacuous personal badge. **The badge has three states, not two**: `store.go:173` writes `LocationVerified: true` on *every* clock-in, personal included, and `Assign` is the only other writer — so on a personal entry the field is vacuous, a green "Location verified" would tick a check that never ran and "Not verified" would accuse a worker of something the server never looked for; personal entries get a muted "Location not checked" that claims neither. The unverified copy says "clock-in **or** clock-out", not the plan's "at clock-in time": `withinAnchor` re-measures *both* stored fixes and returns a single bool without recording which one missed (`handler.go:589-604`), so naming the clock-in would be a guess printed as fact. Two smaller ones: the assign outcome is announced with `AccessibilityInfo` on **iOS only** — `accessibilityLiveRegion` is Android-only (`ViewAccessibility.d.ts:241`) and the success branch unmounts the button the user was focused on, so iOS otherwise gets silence for an irreversible action; it is `announceForAccessibilityWithOptions(..., {queue: true})` because an unqueued announcement racing that same unmount is the one VoiceOver drops. And `INTERNAL` is mapped like `UNKNOWN` rather than falling through to `message`: `httpx.ErrorHandler` renders every non-`AppError` as the bare string `"internal error"` (`httpx/errors.go:33`), and assign is unusually exposed to one (anchor decrypt, DEK unwrap and both fixes opened, the update, then the view re-encrypted) — and `store.Assign` can have landed before the step that failed, so the copy neither shows the raw string nor claims the shift is still personal.
- 6.4: the flow lives in `src/lib/clockFlow.ts`, not in the screen — every branch is a way to lose or double hours, and inside a component none of it is reachable without a renderer this repo does not have. `setPending`, not the plan's `setOpen(local entry), pendingSince=now` (`setOpen` clears the flag). The optimistic entry uses `id: ''`: 7.2 routes `/entry/[id]`, so a fabricated id could open a stranger's shift while a falsy one is a dead route. `clientId` is minted once per *intent*, before the optimistic write, and reused by the body, the entry and the outbox item — a retry that mints a new id turns a lost response into a second shift. The double-tap guard is a **ref**, not state: two taps in one JS tick would both read `busy === false`. `HYDRATE_CODES` extends the plan's `OPEN_ENTRY_EXISTS` with `NO_OPEN_ENTRY` (else a refused clock-out reverts to a shift the server has closed and every later tap 409s) and `UNKNOWN` (a truncated 200 — the write landed and the outbox refuses to replay it, so a hydrate is the only recovery). `OUT_OF_RANGE` copy uses `details.limit_m`, not the plan's literal "1 km": the radius is one deployment-wide env var the app keeps a stale copy of, and sending a worker to 1 km when the server enforces 150 m sends them somewhere that will refuse them again. **`Alert` cannot be the only thing that settles the confirm promise** — it is an empty function on web, and on Android a paused host stashes the dialog on a `FragmentManagerHelper` that is re-minted on every access, so `onHostResume` reads a different instance and the fragment is never shown. Either strands the tap guard and kills the clock button for the session; the guard is `Platform.OS === 'ios' || AppState.currentState === 'active'`. The `web` target was kept and fixed (`output: "static"` → `"single"`, since static rendering prerenders through Node and the app is entirely behind a session): deleting the block does **not** remove web — it produces a byte-identical bundle, so removal would have shipped a working web build while looking removed.
- 6.3: **not** `BottomSheet` from `@expo/ui/universal` as the plan names it — that specifier does not resolve (the package exports `.`, `./swift-ui`, `./jetpack-compose`, `./community/*`; there is no `universal` key) and its real props are `isPresented`/`onDismiss`, not `isOpened`. `BottomSheet` does exist and is genuinely universal, but its children are SwiftUI/Compose nodes rather than RN views, and **Android has no `contentDescription` modifier** — the registered list has none, and `semantics` only sets autofill `contentType` — so a composed `accessibilityLabel` is unreachable there. That matters because the requirement is specifically that an out-of-range row stay tappable and *not* be announced as unavailable. (iOS alone would have worked: `swift-ui` exports a natively-wired `accessibilityLabel` modifier. `@expo/ui/community/bottom-sheet` takes plain RN children and needs no new dependency, but carries `RNHostView`'s mount-time `matchContents` constraint — more machinery than a six-row list needs.) So: RN core `Modal`, per §7.1's "use Expo UI only if a universal component fits without fighting it". The sheet is controlled with **two** callbacks, `onSelect` and `onDismiss`, so no dismissal path — backdrop, Cancel, Android back — can structurally reach a clock-in. Rows are in membership order, never nearest-first: the sheet stays open across a 15 s poll and re-sorting would slide a row out from under a descending thumb. Out-of-range rows carry a muted *name* with the reason line at full contrast, the state in words rather than colour, and **no `disabled` and no `accessibilityState`** anywhere. `accessibilityViewIsModal` is required because RN's `transparent` Modal presents `OverFullScreen`, which leaves the screen behind it in the accessibility tree.
- 6.1: the disabled-clock state closes 4.2's one-way door. It branches on `permission.canAskAgain`, not on `status` — status alone gets iOS wrong, where a user who denied at the OS prompt can never be re-prompted (`requestPermissions` short-circuits unless the status is Undetermined), while the "Not now" cohort is still Undetermined and *can* be. So `canAskAgain` → push `/permissions`, else `Linking.openSettings()`. `useForegroundPermissions()` reads once at mount with no listener and `permissions.tsx` calls the *module* function, so the screen re-reads via the hook's `get()` on focus **and** on `AppState` active — otherwise the button stays dead for exactly the users who just fixed it (returning from Settings never blurs; returning from the explainer never backgrounds). Elapsed is recomputed from `clock_in.at` every tick rather than incremented, so a throttled or suspended timer self-corrects and needs no AppState handling; the interval keys on the timestamp, not the entry object, or every hydrate would rebuild it mid-shift. `Math.floor` on minutes, not `formatDuration`'s rounding — a stopwatch reading "1m" at 30 s errs against the worker when the number is pay. "Last shift" comes from a `lastClosed` field on the clock store, keyed on `clock_out.at` (the shift most recently *ended*, which is what the screen must show the instant someone clocks out) — free, because `hydrateFromServer` already fetches and discards the whole list.
- 5.2: **401 is retryable**, not a drop. `getToken` rejecting (a dead or unrenewable session — the long-offline case the outbox exists for) surfaces as `ApiError(401)`, and dropping on 4xx meant one expired session destroyed *every* queued item in a single pass, silently, for a condition that resolves the moment the same user signs back in. A session verdict is not a verdict on the item. The queue is **not scoped to a user**, so 8.1's sign-out must call the exported `clearForSignOut()` — not the two obvious lines inline: `persist.clearStorage()` bumps zustand's `hydrationVersion`, which cancels an in-flight launch rehydrate *including its callback*, and that callback is the only other thing that releases the flush gate — so a sign-out racing launch wedges the queue dead for the process lifetime. Omitting `clearStorage()` is not an option either: the custom `merge` then resurrects the previous worker's clock-in and sends it under the new account. 8.1 must also flush or warn when `items.length > 0`, or signing out silently destroys the hours the 401 change exists to protect. Ping batches are chunked at **enqueue**, not flush — a >64 batch is a 400, which is non-retryable, so an unsplit item would be dropped rather than retried. `needsAttention` evicts *newest* on overflow: every cascade that can overflow produces near-identical records, so evicting oldest threw away the earliest and most likely real hours. Pings are **not** idempotent (no server-side key), so an accepted-but-unacknowledged batch replays as duplicate breadcrumbs — breadcrumbs, not hours.
- 5.1: `hydrateFromServer()` queries an **unbounded** window, not the plan's `listEntries(today)`. `Store.List` filters on `clock_in.at`, so a today-bound filters on when the shift *started* — it would miss an ordinary 23:30 overnight shift, and miss a stranded entry entirely (nothing ages one out: no TTL, no sweeper, and clock-out has no past bound). The failure is self-sealing into a loop, because 6.4 answers `OPEN_ENTRY_EXISTS` by calling this same function. The cost is real — the list endpoint decrypts both clock points per entry, so a hydrate is ~2N decrypts and the user's whole coordinate history on the wire — but there is no cheaper route today: `Store.OpenEntry` exists and no route exposes it. The upgrade is a `status=open` filter server-side, explicitly **not** a narrower date window. Writes are ordered by a module-scope generation counter, not by `pendingSince`: `setOpen` clears that flag, so an outbox write accepted while a hydrate is in flight would otherwise disarm the guard and the stale `[]` response would wipe a live shift. `setPending` was added beyond the plan's shape — the plan requires `pendingSince=now` but gives no setter, so 6.4 would have reached for raw `setState`. **Known ceiling for 9.1**: `pendingSince` is one global flag for a per-item queue property, so a flush that accepts a queued clock-in while a queued clock-out is still waiting drops the pill for one request's width; key it off `outbox.items.length` instead, or only call `setOpen` after the last clock item in a flush.
- 4.2: the "explainer seen" flag lives in a **new `src/stores/ui.ts`**, not the `ui` slice of the session store the plan names — `session.ts` holds the access token and `me` and is deliberately unpersisted, so wrapping it in `persist` would write credentials into plain AsyncStorage files. zustand's `hasHydrated()` is not reactive, so `hydrated` is a state field set from `onRehydrateStorage`'s returned callback, which fires on read *error* as well as success — a corrupt store must land on defaults rather than hang the gate on a spinner (`ui.test.js` pins exactly that, and the corrupt/rejecting cases are the ones no device would ever show). The location branch of the gate is a **direct render**, not a third `Stack.Protected` group (which would unregister `/permissions` once seen, so profile could never link to it) and not a `<Redirect>`: guarding `(tabs)` off instead would strand the user, because `StackRouter` only re-seeds to `routeNames[0]` when *no* route survives the filter, and `permissions` survives. Gate order matters — the `me`-failure Retry block must come before the permission wait, and the hydration wait must come before the permission read, or a returning user blocks on an OS read that has no error channel (`usePermission` never resolves on rejection). Foreground only; background is asked in phase 5 at first clock-in. **Known gap**: after "Not now" there is no route back to the explainer until 6.1's disabled-clock state or 8.1's profile link exists — and iOS shows no Settings row for an app that never requested location, so a deep link would not rescue it either.
- **Backend change made mid-phase (user decision)**: the offline outbox was unimplementable as designed. `docs/design.md` §5.3 promises a fully offline app, but §4.5 rule 3 rejected any fix older than 5 minutes, and the outbox drops 4xx — so every offline clock-in replayed late was permanently lost, including 10.5's own acceptance test. Fixed server-side, not client-side: the capture time is the payroll record and must not be rewritten at flush. `POST /v1/entries/clock-{in,out}` now take `queued: bool`; when set, only the *past* staleness bound relaxes — mock, accuracy, anchor distance and the clock-out-after-clock-in ordering all still apply, and the future bound stays at `MAX_CLOCK_SKEW` because a clock running fast is still a broken clock. Clock-in is bounded by a new `MAX_QUEUED_AGE` (72 h, rejects with the new **`QUEUED_TOO_OLD`** 422) since hours are money and unbounded backdating is fraud; clock-out has **no** past bound, because refusing a late close cannot un-assert hours already on record — it only strands the shift open, and no endpoint can then close it. Any accepted queued event older than `MAX_CLOCK_SKEW` gets a `backdated` flag on the entry so the employer sees hours that were asserted rather than measured. `Entry.flags` can therefore now be `"speed_anomaly"` **or** `"backdated"`.
- 4.1: `distanceM` mirrors `geo.go`'s `haversineM` term for term (halving folded into the deltas, `2*asin(min(1,sqrt(a)))`, `earthRadiusM = 6371000`); `fix.test.js` pins it against values generated by running the Go function itself, tolerance 1e-6 m — a radius change shows up as 0.16–1.1 m, so there is ~180× headroom. Also exports `inRange`, which mirrors `WithinAnchor` **including its rounding**: the server accepts a fix at 1000.3 m (`Round(…) <= 1000`), so a screen writing `d <= 1000` would show "out of range" where the server says yes. `ANCHOR_RADIUS_M` is a hardcoded copy of a server default that is never sent on the wire — if an operator retunes it, every client badge is wrong until an app release; the cheap upgrade is learning it from `OUT_OF_RANGE.details.limit_m`. `expo-location` 57 has **no** timeout option, so the 15 s bound is an external `Promise.race`, and `mayShowUserSettingsDialog: false` keeps an Android system dialog from putting human reading time inside that race. GPS failures throw a `LocationError`, deliberately **not** an `ApiError` — `api()` guarantees it only ever throws `ApiError` and the outbox retries on `ApiError.status`, so a fabricated status would queue a clock-in that has no fix. **Unverified**: `getFix()` never ran on a device — the pure mapping (null accuracy, absent `mocked`, ms-epoch timestamp, rejection shape) is tested with a stubbed module, but the native call, the timeout path and the Android `mocked` flag are not.
- 2.2: gate uses `<Stack.Protected>`, not `<Redirect>` — expo-router drops unregistered routes from history entirely (`StackRouter.getStateForRouteNamesChange`), so there is no back-swipe into the tabs, and `<Redirect>` needs a screen context it cannot get beside the root `Stack`. **The landing route is `routeNames[0]`, i.e. whichever `<Stack.Screen>` is declared first in each branch — reordering those lines silently changes where sign-in lands.** `signedIn` is `!!user || hasValidCredentials()`, not `!!user` alone: `Auth0Provider.initialize()` calls `getCredentials()` (a *network* renew) and swallows the failure into `user: null`, so an offline launch with a live refresh token would otherwise render as signed-out — with no recourse, since `authorize()` also needs network. The keychain check is local and works offline. That flag must be invalidated by hand when the gate calls `clearCredentials()` with `user` already null, or `LOGOUT_COMPLETE` changes nothing the effect depends on and the app hangs on a spinner. `router.replace('/(tabs)')` dropped from sign-in (plan said to include it): `authorize()` success sets `user` and the guard flips, so adding an imperative navigation would race the guard for one destination. The location-permission branch of the gate is deferred to 4.2, which owns the "explainer seen" flag — gating on OS `undetermined` alone would loop anyone who tapped "Not now". Missing `EXPO_PUBLIC_AUTH0_DOMAIN`/`CLIENT_ID`/`AUDIENCE` render a config message instead of crashing at root render (`Auth0Provider` constructs its client *during* render and validates eagerly). **Unverified**: no Auth0 tenant or native build here, so Universal Login, `USER_CANCELLED`, Android `resumeSession` recovery, and the gate's runtime transitions are reasoned from source, never executed — `mobile/` has no React renderer and adding one would need new devDependencies.
- 2.1: `getAccessToken()` uses the **non-hook `Auth0` singleton**, not `useAuth0()` — the outbox flushes from NetInfo/AppState listeners, which are not components. Safe because `Auth0ClientFactory` caches clients by a config signature (`domain, clientId, localAuthenticationOptions, timeout, useDPoP, maxRetries, credentialsManagerStorageKey`), so the provider and the singleton resolve to the *same* client object — hence one shared exported `auth0Config` that `_layout.tsx` spreads; two literals that drift on any signature key would silently split into two clients with separate credential stores. `useDPoP: false` (v5 defaults it on) because `backend/internal/auth/jwt.go` never inspects `cnf` — DPoP would add `DPOP_KEY_MISSING`/`DPOP_KEY_MISMATCH` session-loss modes for zero enforcement. **iOS classification trap**: Auth0.swift 2.24.1 has no `noNetwork` case, and `NativeBridge.swift` forwards the underlying `AuthenticationError.code` for `renewFailed`, so an offline refresh arrives as `a0.sdk.internal_error.{plain,unknown,empty}` — codes `ERROR_CODE_MAP` doesn't know, collapsing to `UNKNOWN_ERROR`. Matching only the normalised `.type` therefore signed iOS users out while offline and made the outbox discard their clock-in; the fix also matches the raw `e.code` prefix, plus `too_many_requests` (an Auth0 brute-force block makes sign-out strictly worse — Universal Login is blocked too). `getCredentials(undefined, 60)` sets a 60 s TTL floor so a token cannot expire in flight and 401 into a sign-out. `mobile/src/stores/session.test.js` + `npm test` pins both directions of that classification against the real shipped error class (`node --test`, no framework, no new devDependencies; `.js` because a `.ts` test would need `@types/node`).
- 3.1: task order swapped — task 3 built before task 2. `stores/session.ts` needs the typed endpoints for `loadMe()`, and the endpoints need a token, which is a cycle. Broken the same way the web app already does it (`web/src/lib/api.ts:29`): `client.ts` imports nothing at all and takes `setApiAuth({getToken, onUnauthorized})` from the session provider at startup. `AbortSignal.timeout()`/`AbortSignal.any()` do **not** exist on RN 0.86 (Hermes polyfills abort via the `abort-controller` package, which has neither), so the 15 s timeout is `AbortController` + `setTimeout` cleared in `finally`, and a caller-supplied `signal` is replaced rather than composed. Empty-body handling deliberately diverges from `web/src/lib/api.ts:61` — no mobile-facing route 204s, so a blank 200 is truncation and must throw rather than return `undefined as T` (which would escape the outbox classifier as a raw `TypeError`). `getToken` contract lives on the `setApiAuth` JSDoc: `ApiError` means network-and-retryable, any other rejection signs the user out — Auth0 rejects `getCredentials()` with `NO_NETWORK` when offline, and collapsing that to 401 would both wipe the session and make the outbox discard the queued clock-in.
- 1.2: config lives in `app.config.ts` (TS), not `app.json` — the plan's env-var requirement needs `process.env`. No `extra` block: `EXPO_PUBLIC_*` vars are inlined at build time, so reading them directly beats an `extra` + `Constants.expoConfig.extra` indirection hop. `expo-location` plugin also needs `locationAlwaysPermission` (background is enabled, and App Review reads `NSLocationAlwaysUsageDescription`, which otherwise gets a generic auto-string) and `motionUsagePermission: false` (the plugin writes `NSMotionUsageDescription` unconditionally for an API ClockIt never calls). `userInterfaceStyle: "light"` — the theme is a single light palette, so `automatic` would render dark `@expo/ui`/native chrome over light screens. `expo-task-manager` installed now, not in phase 5: it is not a transitive dep of `expo-location`, and `startLocationUpdatesAsync` needs it — adding it later would force the native rebuild the pre-landed background keys exist to avoid. Auth0Provider + auth gate deferred to task 2 (they need the session store). CI/EAS must inject `EXPO_PUBLIC_AUTH0_DOMAIN`; without it the `react-native-auth0` plugin aborts prebuild.
- 1.1: SDK 57 default template is **src-based** — router root is `mobile/src/app/`, not `mobile/app/` (Expo: "only the `src/app` directory will be used if you have both", so root-level `app/` files would silently never load). All file paths above rewritten accordingly; `docs/design.md` §5.1's tree still shows the root-level form. `@expo/ui` ships with the template, so `expo install @expo/ui` was a no-op (`expo install --check` used to confirm). Versions: Expo SDK 57.0.12, `@expo/ui` 57.0.10, expo-router 57.0.12, RN 0.86.2, TS ~6.0.3.
