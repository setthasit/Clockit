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
  - [ ] 1.1: Astryx + Vite + router skeleton
  - [ ] 1.2: `lib/api.ts` + `lib/format.ts`
- [ ] Task 2: Auth
  - [ ] 2.1: Auth0Provider + route guard + sign-in page
- [ ] Task 3: Shell & onboarding
  - [ ] 3.1: AppShell (nav + employer switcher)
  - [ ] 3.2: Onboarding: create employer + MapAnchorPicker
- [ ] Task 4: Employees view
  - [ ] 4.1: Members table + add dialog + inline rate + remove
- [ ] Task 5: Calendar view
  - [ ] 5.1: WeekCalendar grid component
  - [ ] 5.2: EntryBar + popover + route wiring
- [ ] Task 6: Table view
  - [ ] 6.1: Report table (day groups)
  - [ ] 6.2: TipCell inline edit
  - [ ] 6.3: CSV export
- [ ] Task 7: Settings
  - [ ] 7.1: Employer profile + anchor edit
- [ ] Task 8: Verification

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

### Task 3: Shell & onboarding

#### 3.1: AppShell

**File**: `web/src/components/AppShell.tsx`

Astryx navigation shell: left nav — Calendar, Table, Employees, Settings; top bar — employer switcher (Astryx select; hidden when only one employer; selection in `localStorage`, exposed via a small `EmployerContext` holding `{employer, setEmployerId}`) + user avatar menu (email, sign out). "New employer" item in the switcher → `/onboarding`.

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

### Task 4: Employees

**File**: `web/src/routes/employees.tsx`

Astryx table: name (or "—" pending), email, status chip (invited/active/removed), hourly rate — inline editable currency cell (dollars in UI, **cents over the wire**, `PATCH .../members/{mid}` on blur/Enter, optimistic + revert on error), row menu → Remove (confirm dialog; removed rows collapse into a "Removed" section, re-invitable). Header button "Add employee" → dialog with email field → `POST .../members`; `ALREADY_MEMBER` shown inline. Note under rate column header: "Rates are never visible to employees."

### Task 5: Calendar

#### 5.1: WeekCalendar

**File**: `web/src/components/WeekCalendar.tsx`

Hand-rolled (design §6.2): props `{ weekStart: Date, tz: string, entries: EmployerEntry[], onEntryClick }`. CSS grid — time gutter + 7 day columns; 24 rows × 48 px; horizontal hour lines; sticky day header (weekday + date, today highlighted). Entries → absolutely positioned bars in their day column: `top = minutesSinceMidnight(clockIn, tz) * pxPerMin`, `height = durationMins * pxPerMin` (min-height 18 px); midnight-spanning entries render two segments. Color: stable per-member assignment from an 8-color palette derived from the brand hue (member id hash → index). Overlapping bars in one column split the width side-by-side (simple lane algorithm: sort by start, assign first free lane). Open entries (no clock-out) render to "now" with a pulsing edge. Header controls: prev/next week, "Today", week-range label.

#### 5.2: EntryBar + wiring

**Files**: `web/src/components/EntryBar.tsx`, `web/src/routes/calendar.tsx`

Bar: member name + `9:02–17:35`; dashed border + tooltip when `location_verified === false`; small flag icon when `flags` non-empty. Click → Astryx popover: member, times, duration, verified badge, flags, "View in table" link. Route fetches `GET /v1/employers/{id}/entries?from=weekStart&to=weekEnd` on employer/week change; loading skeleton; empty state ("No shifts this week").

### Task 6: Table

#### 6.1: Report table

**File**: `web/src/routes/table.tsx`

Date-range picker (Astryx; presets: This week, Last week, This month) → `GET /v1/employers/{id}/report?from&to`. Grouped by day: day header row — date label, **TipCell**, day totals (hours / base pay / tips / total); member rows — name, in–out, `h:mm`, rate, base pay, tip share, total (server-computed cents; web only formats). Unverified-location rows get the amber dot + tooltip. Footer: range grand totals.

#### 6.2: TipCell

**File**: `web/src/components/TipCell.tsx`

Inline currency input in the day header: blur/Enter → `PUT /v1/employers/{id}/tips/{date}` (cents) → refetch the report (splits are server-derived; no client math). Saving spinner, error toast + revert. Empty ⇒ 0.

#### 6.3: CSV export

**File**: `web/src/lib/csv.ts`

`reportToCsv(report): string` — header `date,employee,clock_in,clock_out,hours,rate,base_pay,tip_share,total`, values RFC-4180-quoted, money as decimal dollars. Button in table header → Blob download `clockit-report-{from}-{to}.csv`. Unit-testable pure function.

### Task 7: Settings

**File**: `web/src/routes/settings.tsx`

Edit name/timezone/anchor (reuses `MapAnchorPicker`, prefilled from the employer) → `PATCH /v1/employers/{id}`. Callout: "Moving the anchor affects future clock-ins only." Danger zone placeholder (delete employer is out of v1 scope — omit the button entirely).

### Task 8: Verification

- [ ] 8.1: `npm run build` + `npx tsc --noEmit` clean; ESLint (flat config, react hooks plugin) clean.
- [ ] 8.2: `csv.test.ts` (Vitest) passes — quoting, money formatting, empty report.
- [ ] 8.3: Manual flow against seeded backend: sign in → onboarding with map pin → employees (add, set rate, remove) → calendar shows seeded week incl. midnight-spanner as two segments + unverified dashed bar → table: set tip 100.00 on a 3-member day, shares sum exactly to 100.00 → CSV downloads and opens.
- [ ] 8.4: Employer switcher: second employer via onboarding; data scopes correctly on switch.
- [ ] 8.5: Non-owner token (employee-only user) gets clean "no employer yet" onboarding, and direct API calls to another's employer return 404 (spot-check in devtools).
