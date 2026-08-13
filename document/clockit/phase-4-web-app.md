# Phase 4: Web App (Employer)

## Context

Design: `docs/design.md` §6 (structure, views, hosting), §4.2 (API), §4.6 (tip split — server computes, web displays), §11 (decisions: Google Maps picker, no money to employees).

Deliverable: the employer SPA against the local backend — Auth0 sign-in, employer onboarding with map anchor picker, employees management, week-calendar, table with tips + CSV. Static hosting config is phase 6; this phase ends at `vite build` producing a deployable `dist/`.

**Dependencies**: Phase 2 (API on `localhost:8080`). Runs parallel to phase 3.

Stack: React 19 + **Astryx** (Meta's design system, StyleX-based) — scaffold per its getting-started docs at `https://astryx.atmeta.com/docs/getting-started` (it ships a CLI; if the CLI scaffold doesn't fit the repo layout, create a Vite react-ts app and add Astryx packages per the same docs — record which path was taken). React Router. `@auth0/auth0-react`. `@googlemaps/js-api-loader` for the anchor picker. No TanStack Query (plain fetch wrapper); no barrel files.

Manual prerequisite (human): Auth0 SPA application (callback/logout URLs `http://localhost:5173`), and a Google Maps JS API key (referrer-restricted) in `web/.env` as `VITE_GOOGLE_MAPS_KEY` — see design §9.

Theme: set Astryx theme tokens so primary/accent = `#00286E`; light/dark follow system. All views use Astryx components first — custom CSS only where Astryx has no fit (calendar grid).

## Tasks

- [ ] Task 1: Scaffold
  - [x] 1.1: Astryx + Vite + router skeleton
  - [x] 1.2: `lib/api.ts` + `lib/format.ts`
- [x] Task 2: Auth
  - [x] 2.1: Auth0Provider + route guard + sign-in page
- [x] Task 3: Shell & onboarding
  - [x] 3.1: AppShell (nav + employer switcher)
  - [x] 3.2: Onboarding: create employer + MapAnchorPicker
- [x] Task 4: Employees view
  - [x] 4.1: Members table + add dialog + inline rate + remove
- [x] Task 5: Calendar view
  - [x] 5.1: WeekCalendar grid component
  - [x] 5.2: EntryBar + popover + route wiring
- [x] Task 6: Table view
  - [x] 6.1: Report table (day groups)
  - [x] 6.2: TipCell inline edit
  - [x] 6.3: CSV export
- [x] Task 7: Settings
  - [x] 7.1: Employer profile + anchor edit
- [ ] Task 8: Verification (8.1–8.2 done; 8.3–8.5 blocked on the human prerequisites)

## Implementation Details

### Task 1: Scaffold

#### 1.1: Project

**Files**: `web/` per design §6.1 layout — `src/main.tsx`, `src/router.tsx`, `src/routes/{sign-in,onboarding,calendar,table,employees,settings}.tsx`, `src/components/`, `src/lib/`.

Router: `/` redirects to `/calendar`; guarded layout route wraps everything except `/sign-in`. Vite dev proxy: `/api` → `http://localhost:8080` (strip prefix), so the app calls same-origin `/api/v1/...` in dev; `VITE_API_URL` overrides for built deployments.

#### 1.2: Libraries

**File**: `web/src/lib/api.ts` — same contract as the mobile client: `api<T>(path, init?)`, bearer token via an injected `getToken: () => Promise<string>` (set once from an `ApiProvider` component that closes over `getAccessTokenSilently`), `ApiError {status, code, message, details}`. 401 → `loginWithRedirect()`.

**File**: `web/src/lib/format.ts` — `cents(n)` → `$18.00`, `minutesToHM`, `dayLabel(date, tz)`, `timeRange(inISO, outISO, tz)`. All date rendering in the **employer's timezone** (from the employer object) via `Intl.DateTimeFormat(..., { timeZone })` — not browser-local.

### Task 2: Auth

**Files**: `web/src/main.tsx`, `web/src/routes/sign-in.tsx`

`Auth0Provider` with `authorizationParams: { audience: VITE_AUTH0_AUDIENCE }`, `cacheLocation: "memory"`, refresh tokens on. Guard component: `isLoading` → centered spinner; unauthenticated → `/sign-in` (brand hero panel + "Sign in" button → `loginWithRedirect`). After auth: `GET /v1/employers` — zero employers → force `/onboarding`.

**Deviations (done)**: §1.2's "401 → `loginWithRedirect()`" applies only to the `getToken` rejection path (lapsed SSO session). An HTTP 401 now throws to the error banner instead — `getToken` succeeded moments earlier, so the backend refusing that token is a config fault (audience/issuer/skew) that re-auth cannot fix, and with a live SSO session the redirect returns instantly and loops forever. `GuardedLayout` doubles as the ApiProvider (`setApiAuth` in its render body) rather than a separate component. `cacheLocation: "memory"` + the SDK default `useRefreshTokensFallback: false` means a page reload signs the user out to `/sign-in` (the click re-auths silently via the SSO cookie) — accepted, upgrade path noted in `main.tsx`.

### Task 3: Shell & onboarding

#### 3.1: AppShell

**File**: `web/src/components/AppShell.tsx`

Astryx navigation shell: left nav — Calendar, Table, Employees, Settings; top bar — employer switcher (Astryx select; hidden when only one employer; selection in `localStorage`, exposed via a small `EmployerContext` holding `{employer, setEmployerId}`) + user avatar menu (email, sign out). "New employer" item in the switcher → `/onboarding`.

**Deviations (done)**: the switcher is `TopNavHeading`'s `menu` (`NavHeadingMenu`/`NavHeadingMenuItem`), not a Selector — Astryx's own Selector guidance forbids using it for navigation, and a sentinel option makes a screen reader announce "New employer" as a selectable value. It shows at any employer count, which also keeps `/onboarding` reachable for single-employer accounts. Context is `{employers, employer, setEmployerId, refresh}`; `refresh()` is how a newly created employer enters the app, and it deliberately keeps the current list on screen so the caller is not unmounted. Routes inside the shell use `useActiveEmployer()`, which is non-null by construction — an `employer?.timezone ?? browserTz` fallback would silently render the wrong day boundaries. `GuardedLayout` owns the single fetch and provides the context; `/onboarding` is its chrome-free sibling of `<Shell/>`.

#### 3.2: Onboarding

**Files**: `web/src/routes/onboarding.tsx`, `web/src/components/MapAnchorPicker.tsx`

Form (Astryx fields): name; timezone (`Intl.supportedValuesOf("timeZone")` select, default browser tz); anchor via `MapAnchorPicker`:

```tsx
// @googlemaps/js-api-loader; default center: browser geolocation if granted, else continent view.
// Draggable marker + google.maps.Circle radius 1000m recentered on drag + "Use my location" button.
// onChange({lat, lng}); lat/lng also shown as editable numeric inputs (map and inputs stay in sync).
<MapAnchorPicker value={anchor} onChange={setAnchor} />
```

Submit → `POST /v1/employers` → set as active employer → `/employees` with a "add your first employee" empty-state.

**Deviations (done)**: `@googlemaps/js-api-loader@2.1.1` removed the class API — `new Loader()` now throws — so the picker uses module-scope `setOptions()` + `importLibrary()`. Legacy `google.maps.Marker`, not `AdvancedMarkerElement`: advanced markers render nothing without a Cloud-console Map ID, which would need a `VITE_GOOGLE_MAPS_ID` var that is in neither the plan nor `.env.example`. Post-create uses a new `addEmployer(employer)` context method rather than `refresh()`: `refresh()` only schedules a refetch, so navigating immediately would hit the guard's zero-employer redirect; the POST returns the same shape the list does, so the refetch buys nothing. `refresh()` remains as the error-banner Retry. Anchor value is `{lat: number|null, lng: number|null}` so entering one coordinate does not invent the other (`0` is a real meridian).

### Task 4: Employees

**File**: `web/src/routes/employees.tsx`

Astryx table: name (or "—" pending), email, status chip (invited/active/removed), hourly rate — inline editable currency cell (dollars in UI, **cents over the wire**, `PATCH .../members/{mid}` on blur/Enter, optimistic + revert on error), row menu → Remove (confirm dialog; removed rows collapse into a "Removed" section, re-invitable). Header button "Add employee" → dialog with email field → `POST .../members`; `ALREADY_MEMBER` shown inline. Note under rate column header: "Rates are never visible to employees."

**Deviations (done)**: status is `StatusDot` + `Text`, not a "chip" — Astryx reserves `Badge` for counts and enumerated states. Employer switching remounts the route via `<Outlet key={employer.id}/>` in the shell, which resets all route state in one line instead of tagging each piece with the employer id; the routes in tasks 5–7 inherit that. Page-level errors use the app's own copy because the backend's strings there are wire-level ("not found", "too many requests"); only the invite dialog surfaces `ApiError.message`, where the wording describes what the user typed. Rate commit reads `e.target.value` and `validity.rangeOverflow/rangeUnderflow` rather than the committed state, because `NumberInput` fires no `onChange` for an empty or out-of-range field and the stale value would otherwise be written; `checkValidity()` is deliberately not used, since `step` makes a legitimate `$18.07` a `stepMismatch`. `toCents` lives in `lib/format.ts` with unit tests pinning the float traps (18.07, 5.29, the 0.005 tie, negatives).

### Task 5: Calendar

#### 5.1: WeekCalendar

**File**: `web/src/components/WeekCalendar.tsx`

Hand-rolled (design §6.2): props `{ weekStart: Date, tz: string, entries: EmployerEntry[], onEntryClick }`. CSS grid — time gutter + 7 day columns; 24 rows × 48 px; horizontal hour lines; sticky day header (weekday + date, today highlighted). Entries → absolutely positioned bars in their day column: `top = minutesSinceMidnight(clockIn, tz) * pxPerMin`, `height = durationMins * pxPerMin` (min-height 18 px); midnight-spanning entries render two segments. Color: stable per-member assignment from an 8-color palette derived from the brand hue (member id hash → index). Overlapping bars in one column split the width side-by-side (simple lane algorithm: sort by start, assign first free lane). Open entries (no clock-out) render to "now" with a pulsing edge. Header controls: prev/next week, "Today", week-range label.

**Deviations (done)**: geometry lives in `src/lib/week.ts` with `week.test.ts` pinning it (tz behind/ahead of UTC, non-hour offsets `Asia/Kolkata` and `Australia/Eucla`, calendar-day divergence, the `h23` midnight trap, midnight splits summing to the original, touching-not-overlapping lanes); the suite passes under `TZ=UTC`, `America/New_York`, `Asia/Kolkata`, `Asia/Kathmandu`. `weekStart` is a `'YYYY-MM-DD'` day key, not a `Date` — a `Date` walks straight into the trap `format.ts` documents. Bar height comes from the two timestamps, not the server's rounded `duration_minutes`, so a bar can never disagree with its own label. Palette is 8 of Astryx's 10 categorical token families (dropping `red` = error and `gray` = disabled), not a brand-hue derivation — Astryx forbids raw hex. Min bar height 20 px (`--spacing-5`); 18 px is not on the token scale. Lane count is per overlap cluster, not per day, so a lone morning shift is not shrunk by a busy afternoon. An open entry is capped at the end of its clock-in day: running it to `now` let one forgotten clock-out squeeze every other entry that week to 1/N width. A clock-skew entry (`clock_out_at` before `clock_in_at`, reachable within the ±5 min tolerance) clamps to a min-height clickable bar rather than vanishing, since task 6's report will show it regardless.

#### 5.2: EntryBar + wiring

**Files**: `web/src/components/EntryBar.tsx`, `web/src/routes/calendar.tsx`

Bar: member name + `9:02–17:35`; dashed border + tooltip when `location_verified === false`; small flag icon when `flags` non-empty. Click → Astryx popover: member, times, duration, verified badge, flags, "View in table" link. Route fetches `GET /v1/employers/{id}/entries?from=weekStart&to=weekEnd` on employer/week change; loading skeleton; empty state ("No shifts this week").

**Deviations (done)**: `from` is widened by one day — the backend windows on `clock_in.at` only, so a shift starting Saturday 22:30 and crossing into the displayed week is otherwise never returned; `layoutWeek` already drops the out-of-range segments. Week bounds are converted to RFC3339 by a new `startOfDay(day, tz)` in `week.ts`: a wall-clock midnight's UTC offset is only knowable once the instant is roughly known, so it probes twice and, where midnight does not exist (Santiago and Havana spring forward at midnight, both on a Sunday — exactly `weekStart + 7`), takes the transition instant. An oracle sweep over all 418 IANA zones × 2011–2035 (3.8 M day/zone pairs) shows zero wrong-day results; the 30 remaining cases are zones where midnight happens *twice*, which land on minute zero of the right day up to three hours late and can only affect `from` (a late `to` merely widens the half-open `[from, to)` window). Upgrade path is a binary search, noted in the code. **URL contract for task 6.1**: "View in table" links to `/table?from=YYYY-MM-DD&to=YYYY-MM-DD` using the entry's **clock-in** day on both ends — a midnight-spanner scoped to its second day would open a table that does not contain it.

### Task 6: Table

#### 6.1: Report table

**File**: `web/src/routes/table.tsx`

Date-range picker (Astryx; presets: This week, Last week, This month) → `GET /v1/employers/{id}/report?from&to`. Grouped by day: day header row — date label, **TipCell**, day totals (hours / base pay / tips / total); member rows — name, in–out, `h:mm`, rate, base pay, tip share, total (server-computed cents; web only formats). Unverified-location rows get the amber dot + tooltip. Footer: range grand totals.

**Deviations (done)**: the report response carries neither clock in/out instants nor `location_verified`, so the route makes a second `GET /entries` call for the same window (one `Promise.all`, one failure banner) and joins on `${clock-in day in employer tz}|${user.id}` — the same key the server groups on, verified against the Go source for day key, identity, open-shift exclusion and window bounds. Only closed entries join: the report pays no minutes for an open shift, so showing its hours beside a total that excludes them would contradict the money. Upgrade path (put the instants and the verdict on the report row, delete the call) is noted in the code. The range lives in the query string rather than component state, so `/table?from&to` is linkable and survives reload; the calendar's link contract is honoured. Grand totals are a bold body row, not `<tfoot>` — Astryx's `TableFooter` is children-mode only. That sum is the page's **only** arithmetic (the response has no range totals); every other figure is rendered exactly as the server computed it, and nullable per-row fields are structurally excluded from it. Join and money logic live in `src/lib/report.ts` with `report.test.ts` pinning them. Amber dot gets a visible legend line — Astryx forbids conveying status by colour alone, and hover does not exist on touch.

#### 6.2: TipCell

**File**: `web/src/components/TipCell.tsx`

Inline currency input in the day header: blur/Enter → `PUT /v1/employers/{id}/tips/{date}` (cents) → refetch the report (splits are server-derived; no client math). Saving spinner, error toast + revert. Empty ⇒ 0.

**Deviations (done)**: no revert path is needed — the cell renders only server numbers, never an optimistic one, so a failed `PUT` leaves the old pool beside the old shares with nothing to undo. It does echo the `PUT`'s own `200 {"tip":{amount_cents}}` until the refetch lands, because otherwise the day header re-showed the value the user had just replaced, which reads as a failed save and invites a duplicate write. Enter is handled in `onKeyDown`, not `onEnter`: `onEnter` carries no event and so cannot see an emptied field, which is the case "empty ⇒ 0" depends on; the handler calls `preventDefault()` so the same keystroke's `keypress` does not activate the newly focused trigger and reopen the editor. The blur guard adds `validity.badInput` to the two checks employees.tsx uses — `-`, `.`, `1e` all present as an empty value and would otherwise write `0` over a real tip pool. Error surface is Astryx `useToast` (imported from `@astryxdesign/core/Toast`; the docs advertise a `./useToast` subpath that does not exist in the package exports); `LayerProvider` is now mounted in our `AppShell` — Astryx's own `AppShell` still has it as a TODO, so the toast was falling back to a self-mounted viewport on `document.body`.

#### 6.3: CSV export

**File**: `web/src/lib/csv.ts`

`reportToCsv(report): string` — header `date,employee,clock_in,clock_out,hours,rate,base_pay,tip_share,total`, values RFC-4180-quoted, money as decimal dollars. Button in table header → Blob download `clockit-report-{from}-{to}.csv`. Unit-testable pure function.

**Deviations (done)**: the file is a flat ledger, not a transcript of the screen — it omits the day-total and range-total rows the table draws, because repeating them made every money column sum to 3× under a naive `SUM()` with no machine-readable way to filter them out. It gains one `Unassigned tip` line per day where `tip_cents !== total_tip_share_cents`, so entered-but-undistributed tip money cannot vanish; that condition (not `rows.length === 0`) is the correct one, since `SplitByMinutes` also returns all zeros when every entry rounds to zero minutes. The split is binary — the pool is distributed exactly or not at all — so the pool is emitted directly and no subtraction is needed, keeping `report.ts`'s range sum the view's only arithmetic. The `employee` column is escaped against spreadsheet formula injection (leading `= + - @ tab CR` gain a quote); it is the only user-supplied field, and the file carries hourly rates. `hours` stays `h:mm` — decimal hours would be client arithmetic. Shifts hang off `Row.shifts` rather than being re-looked-up by `Row.key`, which was a silent-failure coupling no test covered. The export button is disabled while a refetch is in flight **or** failed, so a CSV can never be generated from the window where `TipCell` shows a saved tip beside stale shares. `dollars()` sits beside `cents()` in `format.ts`, both routed through one rounding guard. Signature is `reportToCsv(report, tz, from, to)`; the BOM lives in the Blob, never in the pure function.

### Task 7: Settings

**File**: `web/src/routes/settings.tsx`

Edit name/timezone/anchor (reuses `MapAnchorPicker`, prefilled from the employer) → `PATCH /v1/employers/{id}`. Callout: "Moving the anchor affects future clock-ins only." Danger zone placeholder (delete employer is out of v1 scope — omit the button entirely).

**Deviations (done)**: the form is duplicated from onboarding rather than extracted — every prop a shared `<EmployerForm>` would need (initial values, submit label, cancel, callout, heading, submit function) is a thing that differs, and what the two share is three Astryx components already at their abstraction. Only `timezoneOptions(current)` was lifted (`src/lib/timezones.ts`), because widening `Intl.supportedValuesOf` when it omits the current zone is the one piece with logic and a non-obvious reason — a saved employer can already sit on an alias like `Asia/Calcutta`. Propagation uses a new `updateEmployer(employer)` on the context for the same reason 3.2 chose `addEmployer`: `refresh()` only schedules a refetch, so the top-bar name and the timezone the calendar and table bucket by would stay stale for a round trip. Only `name` is re-seeded from the response (the backend trims it; timezone and anchor come back verbatim), and only when the user has not typed on during the flight — re-seeding all three discarded in-flight keystrokes. No `Card`: Astryx's own Card doc says page sections and form groups use `Section` instead, which overrides the looser line in `web/AGENTS.md`. "Callout" is `Banner status="info"` — Astryx ships no `Callout`. Error copy branches on `ApiError.code`, per the backend catalog's "clients key UX off Code"; `404` gets its own message since a stale `localStorage` id makes it genuinely reachable here, and the raw `"not found"` tells an employer nothing. Note for future readers: `/calendar`, `/table` and `/settings` are siblings under one `<Outlet>`, so only one is mounted at a time and both refetch on remount — the `tz` term in `table.tsx`'s `settled` tag is defensive, not load-bearing.

### Task 8: Verification

- [x] 8.1: `npm run build` + `npx tsc --noEmit` clean; ESLint (flat config, react hooks plugin) clean.
- [x] 8.2: `csv.test.ts` (Vitest) passes — quoting, money formatting, empty report.
- [ ] 8.3: Manual flow against seeded backend: sign in → onboarding with map pin → employees (add, set rate, remove) → calendar shows seeded week incl. midnight-spanner as two segments + unverified dashed bar → table: set tip 100.00 on a 3-member day, shares sum exactly to 100.00 → CSV downloads and opens.
- [ ] 8.4: Employer switcher: second employer via onboarding; data scopes correctly on switch.
- [ ] 8.5: Non-owner token (employee-only user) gets clean "no employer yet" onboarding, and direct API calls to another's employer return 404 (spot-check in devtools).

**8.1 / 8.2 results**: `npx tsc --noEmit` exit 0, `npm run lint` clean, `npm run build` clean (`dist/` = 0.45 kB html + 155 kB css + 894 kB js, 268 kB gzipped; Rolldown's >500 kB chunk advisory is the only output — code-splitting is a phase-6 hosting concern, not a build failure). `npx vitest run` 31/31 across four test files, and green under `TZ=UTC`, `America/New_York`, `Asia/Kolkata`, `America/Santiago`, `Pacific/Kiritimati` and `Asia/Kathmandu` — the timezone-dependent suites (`week`, `report`, `format`, `csv`) pin behaviour rather than the runner's zone. `csv.test.ts` covers the three mandated cases plus formula-injection escaping, the multi-shift join, blank-vs-`0.00`, and the undistributed-pool line.

**8.3–8.5 NOT RUN — blocked, not skipped.** They need the human prerequisites this plan lists in its Context: an Auth0 SPA application (callback/logout `http://localhost:5173`), a referrer-restricted Google Maps browser key, a `web/.env` holding both, and `make run` + `make seed` against the local stack. The repo has only `.env.example`, so the app cannot authenticate and every one of these steps is gated behind sign-in. What *was* verified per task, in a real browser, is the no-API-key degraded path of the map picker plus each route driven with fixture data through throwaway harnesses; what was **not** verified anywhere in this phase is a single request against the real backend, the Auth0 redirect round trip, `logout()`, or a live tip split summing to 100.00. Run 8.3–8.5 before treating this phase as done.
