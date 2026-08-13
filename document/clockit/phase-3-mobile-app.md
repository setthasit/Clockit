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
  - [ ] 2.1: Auth0 provider + session store
  - [ ] 2.2: Sign-in screen + auth gate
- [ ] Task 3: API layer
  - [x] 3.1: `src/api/client.ts` fetch wrapper
  - [ ] 3.2: Typed endpoints (`me.ts`, `entries.ts`)
- [ ] Task 4: Location helpers
  - [ ] 4.1: `src/location/fix.ts`
  - [ ] 4.2: Permissions explainer screen
- [ ] Task 5: Stores
  - [ ] 5.1: `session.ts` + `clock.ts`
  - [ ] 5.2: `outbox.ts` (persisted queue)
- [ ] Task 6: Clock screen
  - [ ] 6.1: Status card + elapsed timer + ClockButton
  - [ ] 6.2: DistanceBadge (live pre-check)
  - [ ] 6.3: EmployerSheet
  - [ ] 6.4: Clock-in/out flow + error mapping
- [ ] Task 7: History & entry detail
  - [ ] 7.1: History tab (grouped by day)
  - [ ] 7.2: Entry detail + assign employer
- [ ] Task 8: Profile tab
  - [ ] 8.1: Profile screen + sign out
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

Error map (code → copy): `MOCKED_LOCATION` "Mock location detected — disable fake GPS apps.", `OUT_OF_RANGE` "You're {distance_m} from {employer} — move within 1 km.", `LOW_ACCURACY` "GPS accuracy too low — step outside and retry.", `STALE_TIMESTAMP` "Device clock looks wrong — check date & time.", `OPEN_ENTRY_EXISTS` triggers `hydrateFromServer()`. Clock-out identical shape (no sheet). Phase-5 hook points: `onClockedIn(entry)` / `onClockedOut()` empty functions in `src/location/tracking.ts` created now, called from the flow.

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

- 3.1: task order swapped — task 3 built before task 2. `stores/session.ts` needs the typed endpoints for `loadMe()`, and the endpoints need a token, which is a cycle. Broken the same way the web app already does it (`web/src/lib/api.ts:29`): `client.ts` imports nothing at all and takes `setApiAuth({getToken, onUnauthorized})` from the session provider at startup. `AbortSignal.timeout()`/`AbortSignal.any()` do **not** exist on RN 0.86 (Hermes polyfills abort via the `abort-controller` package, which has neither), so the 15 s timeout is `AbortController` + `setTimeout` cleared in `finally`, and a caller-supplied `signal` is replaced rather than composed. Empty-body handling deliberately diverges from `web/src/lib/api.ts:61` — no mobile-facing route 204s, so a blank 200 is truncation and must throw rather than return `undefined as T` (which would escape the outbox classifier as a raw `TypeError`). `getToken` contract lives on the `setApiAuth` JSDoc: `ApiError` means network-and-retryable, any other rejection signs the user out — Auth0 rejects `getCredentials()` with `NO_NETWORK` when offline, and collapsing that to 401 would both wipe the session and make the outbox discard the queued clock-in.
- 1.2: config lives in `app.config.ts` (TS), not `app.json` — the plan's env-var requirement needs `process.env`. No `extra` block: `EXPO_PUBLIC_*` vars are inlined at build time, so reading them directly beats an `extra` + `Constants.expoConfig.extra` indirection hop. `expo-location` plugin also needs `locationAlwaysPermission` (background is enabled, and App Review reads `NSLocationAlwaysUsageDescription`, which otherwise gets a generic auto-string) and `motionUsagePermission: false` (the plugin writes `NSMotionUsageDescription` unconditionally for an API ClockIt never calls). `userInterfaceStyle: "light"` — the theme is a single light palette, so `automatic` would render dark `@expo/ui`/native chrome over light screens. `expo-task-manager` installed now, not in phase 5: it is not a transitive dep of `expo-location`, and `startLocationUpdatesAsync` needs it — adding it later would force the native rebuild the pre-landed background keys exist to avoid. Auth0Provider + auth gate deferred to task 2 (they need the session store). CI/EAS must inject `EXPO_PUBLIC_AUTH0_DOMAIN`; without it the `react-native-auth0` plugin aborts prebuild.
- 1.1: SDK 57 default template is **src-based** — router root is `mobile/src/app/`, not `mobile/app/` (Expo: "only the `src/app` directory will be used if you have both", so root-level `app/` files would silently never load). All file paths above rewritten accordingly; `docs/design.md` §5.1's tree still shows the root-level form. `@expo/ui` ships with the template, so `expo install @expo/ui` was a no-op (`expo install --check` used to confirm). Versions: Expo SDK 57.0.12, `@expo/ui` 57.0.10, expo-router 57.0.12, RN 0.86.2, TS ~6.0.3.
