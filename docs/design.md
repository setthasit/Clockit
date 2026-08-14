# ClockIt — System Design

Employee clock-in/clock-out with location validation. Three deliverables: a React Native app for employees, a React web app for employers, and a Go backend on GCP.

- [Architecture diagram](diagrams/architecture.svg)
- [Infrastructure diagram](diagrams/infra.svg)
- [Clock-in flow diagram](diagrams/clock-in-flow.svg)

## 1. Overview

```
Employee (mobile) ──┐
                    ├──> Auth0 (login) ──> JWT
Employer (web) ─────┘
                    ├──> Go API (GKE) ──> MongoDB Atlas (PSC, private)
                    │                 ──> Valkey (in-cluster)
                    │                 ──> Cloud KMS (KEK for envelope encryption)
                    └──> Static web (GCS + Cloud CDN, prod) / nginx on tailnet (beta)
```

| Concern      | Decision                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Scale target | 10–50 employees initially; nothing in the design blocks 100x growth (stateless API, managed DB) |
| Monorepo     | `mobile/`, `web/`, `backend/`, `infra/`, `docs/` in one repo                                    |
| Auth         | Auth0 Universal Login (Google, Apple, Facebook, username/password), one API audience, JWT RS256 |
| Encryption   | Envelope (KEK in Cloud KMS, per-tenant DEK, AES-256-GCM) for location, phone, hourly rate       |
| Proximity    | Server-side haversine ≤ 1000 m against anchor; reject mocked/low-accuracy fixes                 |
| Envs         | `beta` (tailnet-only) and `prod` (public) sharing one GKE cluster, one Atlas cluster, one VPC   |
| Money        | Integer cents everywhere. Timestamps UTC; employer timezone defines the "day" for tips/reports  |

## 2. Repository layout

```
clockit/
  mobile/     # Expo app (employee)
  web/        # React + Astryx (employer)
  backend/    # Go API
  infra/      # OpenTofu + k8s manifests
  docs/       # this doc + diagrams
```

## 3. Authentication (Auth0)

Two Auth0 tenants: `clockit-beta`, `clockit-prod` (standard env separation, both on free tier — currently 25k MAU).

Per tenant:

- **Connections**: `google-oauth2`, `apple`, `facebook`, `Username-Password-Authentication`. Require verified email (social providers give it; database connection enforces email verification before membership linking).
- **Applications**: `mobile` (Native) and `web` (SPA).
- **API**: `clockit-api`, audience `https://api.clockit.duckos.ai`, RS256.
- **Action**: add `email` + `email_verified` custom claims to the access token so the backend never calls `/userinfo`.

Clients use Universal Login (browser-based) — zero credential handling in our code, all four connections for free:

- Mobile: `react-native-auth0` + its Expo config plugin. Refresh token rotation, tokens in Keychain/Keystore (handled by the SDK).
- Web: `@auth0/auth0-react`, in-memory tokens + silent refresh.

Backend: Echo middleware validates JWT against the tenant JWKS (keys cached in memory), extracts `sub`, `email`, `email_verified`. Users are provisioned just-in-time on first authenticated request. There are no Auth0 roles: "employer" is not a role, it is ownership of an employer document. Any user can be an employee and own an employer profile.

Apple sign-in requires an Apple Developer account ($99/yr) — needed anyway for iOS App Store distribution.

## 4. Backend (Go + Echo + fx + MongoDB + Valkey)

### 4.1 Project structure

One package per domain. Handler → store directly; no service/interface layer until two implementations actually exist.

```
backend/
  cmd/api/main.go          # fx.New(...): config, clients, domains, http
  internal/
    config/config.go       # env vars -> struct
    httpx/server.go        # echo, middleware (auth, rate limit, recover, logging), route mounting
    auth/jwt.go            # JWKS fetch/cache, JWT middleware, identity in context
    crypto/envelope.go     # KMS wrap/unwrap, AES-256-GCM seal/open, in-proc DEK cache
    mongox/client.go
    valkeyx/client.go
    otelx/otel.go          # tracer/meter/logger providers, OTLP exporters, fx lifecycle hooks
    user/     handler.go store.go model.go
    employer/ handler.go store.go model.go
    entry/    handler.go store.go model.go geo.go
    tip/      handler.go store.go model.go
  Dockerfile               # distroless, static binary
```

fx provides constructors; domains register routes on the Echo instance via an fx invoke. That is the entire DI story.

### 4.2 API

All routes bearer-JWT except `/healthz`. `{id}` are Mongo ObjectIDs. Bodies/responses JSON.

Employee:

| Method | Path                    | Notes                                                                                                              |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/me`                | Profile + memberships (employer id, name, anchor lat/lng) — anchor lets the app show live distance before clock-in |
| PATCH  | `/v1/me`                | `{name?, phone?}`                                                                                                  |
| POST   | `/v1/entries/clock-in`  | `{client_id, employer_id?, at, loc:{lat,lng,accuracy}, mocked, queued?}`                                           |
| POST   | `/v1/entries/clock-out` | `{client_id, at, loc, mocked, queued?}` — closes the open entry                                                    |
| GET    | `/v1/entries?from&to`   | Own entries                                                                                                        |
| PATCH  | `/v1/entries/{id}`      | `{employer_id}` — assign employer to a personal entry later                                                        |
| POST   | `/v1/pings`             | `{pings:[{at, loc}]}` — batched background pings, attached to the open entry                                       |

Employer (must own `{id}`):

| Method     | Path                                 | Notes                                                          |
| ---------- | ------------------------------------ | -------------------------------------------------------------- |
| POST / GET | `/v1/employers`                      | Create (`{name, anchor, timezone}`) / list mine                |
| PATCH      | `/v1/employers/{id}`                 | Update profile/anchor                                          |
| GET / POST | `/v1/employers/{id}/members`         | List / add by email `{email}`                                  |
| PATCH      | `/v1/employers/{id}/members/{mid}`   | `{hourly_rate_cents}` — never returned by employee endpoints   |
| DELETE     | `/v1/employers/{id}/members/{mid}`   | Remove (soft: status `removed`)                                |
| GET        | `/v1/employers/{id}/entries?from&to` | Calendar + table data                                          |
| PUT        | `/v1/employers/{id}/tips/{date}`     | `{amount_cents}`, `date` = `YYYY-MM-DD` in employer tz; upsert |
| GET        | `/v1/employers/{id}/tips?from&to`    | Tip pool per day — lets the table render tip inputs in one round trip |
| GET        | `/v1/employers/{id}/report?from&to`  | Per employee per day: hours, rate, base pay, tip share, total  |

Idempotency: every mobile mutation carries a client-generated UUID (`client_id`); a unique index dedupes retries from the offline outbox.

### 4.3 Data model (MongoDB, DBs `clockit_beta` / `clockit_prod`)

`enc` = AES-256-GCM blob `version(1) || nonce(12) || ciphertext`, encrypted with the owning tenant's DEK.

```
users        { _id, auth0_sub, email, name, phone_enc?, dek_wrapped, created_at }
employers    { _id, owner_user_id, name, timezone, anchor_enc, dek_wrapped, created_at }
memberships  { _id, employer_id, email, user_id?, status: invited|active|removed,
               hourly_rate_cents_enc?, created_at }
time_entries { _id, user_id, employer_id?, client_id, status: open|closed,
               clock_in:  { at, loc_enc, accuracy, mocked },
               clock_out?: { at, loc_enc, accuracy, mocked },
               location_verified: bool,       # set when employer assigned (see 4.5)
               flags: [ "speed_anomaly", ... ],
               created_at }
location_pings { _id, entry_id, user_id, at, loc_enc, created_at }   # TTL 90 days
tips         { _id, employer_id, date, amount_cents, created_at }
```

Indexes:

- `users`: unique `auth0_sub`, unique `email`
- `memberships`: unique `(employer_id, email)`; `(user_id)`
- `time_entries`: unique `(user_id, client_id)`; **partial unique `(user_id)` where `status: "open"`** — enforces one open shift; `(employer_id, clock_in.at)`; `(user_id, clock_in.at)`
- `location_pings`: `(entry_id, at)`; TTL on `created_at`
- `tips`: unique `(employer_id, date)`

Membership linking: adding a member creates `{email, status: invited}`. On any authenticated request by a user with a verified matching email, invited memberships are claimed (`user_id` set, status `active`). No invite-email flow needed for v1; the employer tells the employee to install the app.

Encrypted coordinates cannot be geo-indexed — irrelevant, because proximity is computed at write time and we never run geo queries.

### 4.4 KEK/DEK envelope encryption

- **KEK**: Cloud KMS symmetric key per env (`kek-beta`, `kek-prod`), 90-day auto-rotation. Only that env's Kubernetes service account has `cloudkms.cryptoKeyEncrypterDecrypter` on its key (Workload Identity).
- **DEK**: random 32-byte AES key per user and per employer, generated at document creation, wrapped via KMS `Encrypt`, stored as `dek_wrapped` on the owning document. KMS rotation only affects new wraps; `Decrypt` transparently handles old key versions.
- **Field mapping**: entry/ping locations + phone → user DEK; anchor + hourly rates → employer DEK.
- **Runtime**: unwrapped DEKs cached in-process (LRU, 15 min TTL) — one KMS call per tenant per 15 min, not per request.
- **Crypto-shredding**: deleting a user/employer deletes `dek_wrapped`; all their ciphertext becomes unrecoverable. This is the cheap GDPR-delete.

```go
// seal: one function, no interfaces.
func Seal(dek, plaintext []byte) []byte   // gcm.Seal(version||nonce, ...)
func Open(dek, blob []byte) ([]byte, error)
```

### 4.5 Location & anti-spoofing rules

Clock-in/out validation (hard reject with a typed error the app can render):

1. `mocked == true` → reject (`Location.getCurrentPositionAsync` exposes the Android mock flag; iOS has no reliable equivalent — see hardening).
2. `accuracy > 100 m` → reject ("move outdoors / enable precise location").
3. `|at - server_now| > 5 min` → reject (stale/replayed fix). Exception for §5.3: a body with `queued: true` is an outbox item captured offline, and `at` must stay the real capture time (it is the payroll record), so the *past* bound widens. The future bound stays 5 min for both events; how far the past bound widens depends on the event:
   - **Clock-in**: to `MAX_QUEUED_AGE` (72 h) — past that it is rejected with `QUEUED_TOO_OLD`.
   - **Clock-out**: no past bound at all. A close asserts no hours the clock-in did not already put on record, and refusing it cannot take those hours back — it only strands the shift open, and the one-open-shift index then blocks every later clock-in with no event able to close it. Its real floor is the clock-in it closes: `at` must be strictly after `clock_in.at`. A shift left open for months closes with a months-old timestamp.

   Only this rule is relaxed; an accepted queued event older than 5 min gets a `backdated` flag — on the stored entry and on the response — so the employer sees hours that were asserted rather than measured. Every close accepted past the 72 h clock-in ceiling is therefore flagged, which holds because the flag threshold is `MAX_CLOCK_SKEW` and startup rejects a config with `MAX_QUEUED_AGE < MAX_CLOCK_SKEW`.
4. Anchor rule:
   - **With employer**: haversine(fix, employer anchor) ≤ 1000 m, else reject with the actual distance.
   - **No employer**: clock-in always passes and its location _becomes_ the anchor; clock-out must be within 1000 m of it.
5. Assigning an employer to a personal entry later re-checks both fixes against the employer anchor and sets `location_verified` — never rejects (the shift already happened); the employer UI shows a verified/unverified badge.

Honest limitation on `MAX_QUEUED_AGE`: 72 h was picked to sit inside a weekly payroll cycle, but it bounds only clock-in, and nothing enforces the cycle — there is no period close or lock anywhere in the system, so an employer who has already paid a week can still receive a shift dated inside it. Clock-out is not bounded at all, so the true reach backwards is the age of the oldest open shift, and nothing ages one out: `time_entries` has no TTL and no sweeper (only `location_pings` expires, §4.3), so an entry opened a year ago is still closable today at its own timestamp. Because the report computes on read (§4.6), such a shift also re-splits that day's tip pool, changing shares that may already have been paid out. The `backdated` flag is the only signal and it currently reaches only `/v1/employers/{id}/entries`, not the report rows the employer pays from. Period locking is the real fix and is out of v1 scope.

Background pings: not validated against the anchor (people move); a ping implying > 200 km/h since the previous one adds a `speed_anomaly` flag to the entry instead of rejecting.

Honest limitation: coordinates come from the client, so a rooted device or patched app can fake them. The mock flag + accuracy + staleness + speed checks stop casual spoofing (mock-location apps). The real fix is device attestation — **Play Integrity API (Android) / App Attest (iOS)** — listed as a hardening phase, not v1.

### 4.6 Tip splitting

Tip `T` for a day (employer tz), employee hours `h_i`, `H = Σh_i`: `share_i = T · h_i / H`, rounded to cents by largest remainder so shares sum exactly to `T`. Entries spanning midnight count toward the day they clocked in. Computed on read in the report endpoint — never stored, so editing a tip or a shift never leaves stale splits.

### 4.7 Valkey

Used for exactly one thing in v1: rate limiting (sliding window per user per route — clock-in spam, login-adjacent abuse). Runs as one small in-cluster pod per env (`valkey:8-alpine`, no persistence — counters are disposable). Idempotency and caching live in Mongo/process memory. If a future feature needs shared cache or pub/sub, the client is already wired.

### 4.8 Observability — full OpenTelemetry (traces, metrics, logs)

Everything OTLP, vendor-neutral, configured through the standard `OTEL_*` env vars (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=beta`, `OTEL_TRACES_SAMPLER`). One `internal/otelx` package sets up the three providers + W3C `tracecontext`/`baggage` propagators and registers flush/shutdown on the fx lifecycle. No custom config layer — the SDK already reads the env vars.

All instrumentation below is verified, maintained upstream:

| Signal source | Package |
|---|---|
| HTTP server spans **and** metrics (`http.server.request.duration`, …) | `go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho` middleware |
| MongoDB command spans/metrics (driver **v2**) | `go.opentelemetry.io/contrib/instrumentation/go.mongodb.org/mongo-driver/v2/mongo/otelmongo` |
| Valkey spans + connection/command metrics (`valkey_command_duration_seconds`, …) | `github.com/valkey-io/valkey-go/valkeyotel` (`valkeyotel.NewClient`) |
| Go runtime metrics (GC, goroutines, memory) | `go.opentelemetry.io/contrib/instrumentation/runtime` |
| Logs | `log/slog` app-wide; `go.opentelemetry.io/contrib/bridges/otelslog` handler exports via OTLP with automatic `trace_id`/`span_id` correlation, fanned out to a stdout JSON handler so `kubectl logs` stays useful (~20-line multi-handler) |

Custom telemetry (the few that matter for this domain):
- Span attributes on clock-in/out: distance to anchor, accuracy, verdict, rejection reason.
- Counters: `clockit.clock_in.total{result}`, `clockit.proximity.rejected.total{reason}`, `clockit.outbox.sync.total{result}`.
- Histogram: KMS unwrap latency (DEK cache effectiveness visible as its rate).

Sampling: `parentbased_traceidratio` — 100% locally and in beta, tuned down in prod via env var only.

Backends: local dev and beta use the `grafana/otel-lgtm` container/pod (Collector + Tempo + Loki + Prometheus + Pyroscope + Grafana in one image — built for exactly this). Prod: one of **HyperDX, OpenObserve, or Grafana Cloud** — all three are OTLP-native, so the choice is a collector exporter config decided at the infra phase, zero app changes either way because the app only ever speaks OTLP. (If OpenObserve or self-hosted HyperDX wins, it can also replace `otel-lgtm` locally/beta for one-backend consistency — both ship as a single container.)

Mobile/web instrumentation is out of scope for v1; because the API propagates W3C trace context, adding OTel-JS or Sentry later joins traces end-to-end without backend changes.

## 5. Mobile app (Expo + Zustand + Expo UI)

### 5.1 Structure

```
mobile/
  app/                       # expo-router
    _layout.tsx              # auth gate + providers
    sign-in.tsx
    permissions.tsx          # location permission explainer (pre-OS-prompt)
    (tabs)/
      _layout.tsx            # tabs: Clock, History, Profile
      index.tsx              # clock screen
      history.tsx
      profile.tsx
    entry/[id].tsx           # entry detail + "assign employer"
  src/
    api/client.ts            # fetch wrapper: base URL, bearer token, typed errors
    api/entries.ts           # clock-in/out, pings, list
    api/me.ts
    stores/session.ts        # zustand: user, memberships
    stores/clock.ts          # zustand: open entry, elapsed
    stores/outbox.ts         # zustand + AsyncStorage persist: pending mutations
    location/fix.ts          # getCurrentPositionAsync(Highest), mocked check, distance()
    location/tracking.ts     # TaskManager task: bg pings every 10 min
    components/              # ClockButton, EmployerSheet, DistanceBadge, EntryRow...
    theme.ts                 # accent #00286E, spacing, radii (plain TS tokens)
```

No barrel files; import concrete paths. Key packages: `expo-location`, `expo-task-manager`, `react-native-auth0`, `zustand`, `@expo/ui` (universal namespace first; native SwiftUI/Jetpack Compose components, custom views use plain StyleSheet), `@react-native-community/netinfo`.

### 5.2 Clock-in UX

- **Clock screen**: dominant status card — "Clocked out" or "On shift since 9:02 · 3h 41m" with a live timer — above one large circular action button (#00286E). Below it, a live `DistanceBadge` when the user has employers: "620 m from Acme Cafe — in range ✓" or red "2.4 km — out of range" (client-side pre-check using anchors from `/v1/me`, purely UX; the server re-validates).
- **Tap Clock In**:
  - 0 employers → clock in immediately, no popup (requirement).
  - ≥ 1 employer → bottom sheet: employer rows (name + live distance, out-of-range rows visually disabled) + a "No employer (personal)" row.
- **Failure states**: typed server errors map to human messages ("Mock location detected", "You're 1.8 km from Acme — move closer", "GPS accuracy too low").
- **History tab**: entries grouped by day; each row shows employer chip (or "Personal"), in–out, duration. Personal entries show "Assign employer" in detail → PATCH, then a verified/unverified badge.
- **Profile tab**: avatar/name/email, memberships ("Added by Acme Cafe"), sign out.
- **Permissions**: a friendly explainer screen _before_ the OS prompts (required practice for App Store review of Always-location apps): why foreground (validate clock-in) and why background (shift tracking pings).

### 5.3 Offline & "save everything"

Outbox pattern, minimal:

1. Every mutation (clock-in/out, assign, pings) gets a `client_id` UUID and is applied to local Zustand state immediately (optimistic — the app is fully functional offline).
2. If the POST fails (offline/timeout), it stays queued in `outbox` (persisted to AsyncStorage).
3. Flush on NetInfo reconnect and app foreground, in order; server unique index on `(user_id, client_id)` makes retries idempotent.
4. Proximity for offline entries: the app records the fix + mock flag at tap time; the server validates on sync and returns a per-item verdict (a rejected item surfaces as "needs attention" on the entry rather than silently vanishing).

### 5.4 Background pings (every 10 min)

Scoped to active shifts only — started at clock-in, stopped at clock-out. Do not track people who are not working: better battery, better privacy, and Apple will reject always-on tracking without a strong justification.

```ts
// location/tracking.ts
TaskManager.defineTask(SHIFT_TASK, ({ data: { locations } }) =>
  outbox.enqueuePings(locations),
);

Location.startLocationUpdatesAsync(SHIFT_TASK, {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 600_000, // Android: honored
  deferredUpdatesInterval: 600_000, // iOS: batches deliveries
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: "On shift",
    notificationBody: "ClockIt is recording your shift",
  },
});
```

Platform truth (verified against expo-location source):

- **Android**: `timeInterval` gives a reliable ~10 min cadence via a foreground service (persistent notification — also honest UX).
- **iOS**: no exact timers; deliveries are deferred/batched and if the user force-quits the app, iOS will not relaunch it for standard location updates. Pings resume at next open. Accepted: pings are supplementary evidence, clock-in/out are the records that matter. State this in the employer UI ("last seen" instead of a fake continuous trail).
- Requires `ACCESS_BACKGROUND_LOCATION` (Android) / "Always" (iOS) + `UIBackgroundModes: [location]` — all via app.json config plugins, EAS builds (no bare workflow).

## 6. Web app (React 19 + Astryx)

### 6.1 Structure

Scaffolded with the Astryx CLI (React 19 + StyleX + Vite). Astryx ships 160+ themeable components — theme token set to accent `#00286E`, light/dark from the system.

```
web/
  src/
    main.tsx                 # Auth0Provider + router
    router.tsx               # react-router: /, /calendar, /table, /employees, /settings
    lib/api.ts               # fetch wrapper (bearer, typed errors)
    lib/format.ts            # cents -> $, minutes -> h:mm, tz-aware dates
    routes/
      sign-in.tsx
      onboarding.tsx         # create employer: name, timezone, anchor map-pin picker
      calendar.tsx           # week view
      table.tsx              # table + tips
      employees.tsx
      settings.tsx           # employer profile, anchor, danger zone
    components/
      AppShell.tsx           # Astryx nav shell + employer switcher
      WeekCalendar.tsx       # custom CSS-grid week view
      EntryBar.tsx           # positioned duration bar + popover
      TipCell.tsx            # inline editable tip amount
```

Data fetching: plain `fetch` wrapper + route-level loading. Skipped TanStack Query — add it when cross-route cache invalidation actually hurts.

### 6.2 Views

- **Onboarding**: create employer profile; anchor picked on a map with a 1 km radius circle drawn so the employer _sees_ the clock-in zone. Map: **Google Maps JS API** — already on GCP, most reliable tiles/geocoding, monthly free tier covers this traffic comfortably. API key restricted by HTTP referrer + API, managed in the tofu `10-foundation` stack.
- **Calendar**: Google-Calendar-style week view. CSS grid, 7 day columns × 24 h rows; each entry is an absolutely-positioned bar (offset = clock-in time, height = duration), one color per employee, unverified-location entries get a dashed border + tooltip. Click → popover: employee, times, duration, distance-verified badge. Hand-rolled (~150 lines) instead of FullCalendar — no heavy dependency, fully Astryx-styled.
- **Table**: date-range filter; grouped by day. Columns: employee, in, out, hours, rate, base pay, tip share, total. Day header row holds the inline **tip input** (PUT on blur) and day totals; splits recompute from the report endpoint. CSV export button (client-side, trivial, employers love it).
- **Employees**: member list, add-by-email dialog, inline rate editor, remove. Invited-but-not-joined shown as pending.

Hourly rates render only here (owner-only routes); employee-facing endpoints never serialize them.

### 6.3 Hosting

Static build → GCS bucket behind the global HTTPS LB + Cloud CDN (prod). Deep links (`/table` refresh) handled by the LB **custom error response policy**: backend-bucket 404 ⇒ serve `/index.html` with response code 200. Hashed asset filenames get long-lived cache headers; `index.html` gets `no-cache`. Beta build is served by a tiny nginx pod inside the beta namespace, reachable only over the tailnet (a public CDN would defeat "beta is tailnet-only").

## 7. Infrastructure (GCP + OpenTofu)

See [infra diagram](diagrams/infra.svg).

### 7.1 Shape

Single GCP project, region **`us-central1`** (users on both coasts — Vancouver and NYC — so split the difference; Atlas region must match for PSC), single VPC. Beta/prod isolation is logical (namespaces, DBs, KMS keys, service accounts) — accepted blast-radius trade-off for the cost requirement; promoting prod to its own project later is a new instantiation of the same stack modules (see 7.2), not a redesign.

| Component    | Choice                                                                                                                                                                 | Beta/prod sharing                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Compute      | **GKE Autopilot**, private nodes                                                                                                                                       | One cluster; namespaces `beta`, `prod`; per-ns KSA via Workload Identity |
| API images   | Artifact Registry                                                                                                                                                      | Shared repo, immutable tags (git SHA)                                    |
| DB           | **Atlas M10** (smallest tier supporting private endpoints — Flex/M0 do not), Private Service Connect (port-mapped, the current architecture; legacy PSC is deprecated) | One cluster; DBs `clockit_beta`/`clockit_prod`, one scoped DB user each  |
| Cache        | Valkey pod per namespace                                                                                                                                               | Cluster shared, instance per env                                         |
| Secrets      | KMS keys `kek-beta`/`kek-prod`; Atlas/Auth0 creds in Secret Manager → k8s Secrets via tofu                                                                             | Keyring shared, keys + IAM per env                                       |
| Ingress prod | One global external ALB: `api.…` → GKE (Gateway API) , `app.…` → backend bucket + CDN, custom-error-response for SPA                                                   | prod only                                                                |
| Ingress beta | **Tailscale Kubernetes operator**: beta `api` Service + beta web nginx exposed as tailnet devices (MagicDNS). No public IP touches beta                                | beta only                                                                |
| Egress       | Cloud NAT (private nodes need it for Auth0 JWKS, Tailscale control plane)                                                                                              | Shared                                                                   |
| DNS/TLS      | **Cloudflare DNS** (zone `duckos.ai`; records managed by tofu via the cloudflare provider). Hosts: `clockit.duckos.ai` (web), `api.clockit.duckos.ai` (API), **DNS-only (grey-cloud)** pointing at the GCP LB. Certs: Certificate Manager with **DNS authorization** (one CNAME in Cloudflare) so issuance never depends on proxy status | prod hostnames only                                                      |

### 7.2 OpenTofu — layered stacks, isolated state

A single root module with one state does not survive growth well: plans get slow, every apply puts all resources at risk, and configuring the `kubernetes`/`helm` providers from a cluster created *in the same state* is the classic Terraform/OpenTofu footgun (provider config depending on a resource output breaks on refactors and destroys). So: **small stacks, one state each, ordered by lifecycle**. Pure modules hold the resources; stacks are thin roots that wire modules together.

```
infra/
  modules/                  # pure, reusable, no provider/backend config
    network/  gke/  atlas/  kms/  edge/  platform/
  stacks/                   # thin roots; each has its own GCS state prefix
    00-bootstrap/           # state bucket, project APIs, WIF pool for GitHub CI
    10-foundation/          # VPC, NAT, Artifact Registry, KMS keyring+keys, Cloudflare records
    20-cluster/             # GKE Autopilot, workload identity
    30-data/                # Atlas project/M10, PSC endpoint, db users
    40-platform/            # kubernetes/helm providers: namespaces, KSAs, secrets,
                            #   tailscale operator, valkey  (cluster already exists → no footgun)
    50-edge/                # ALB, backend bucket, CDN, certs, custom error response, Gateway
  k8s/
    base/                   # api Deployment/Service/HPA, kustomize base
    overlays/beta/          # replicas=1, tailscale annotations, beta image tag
    overlays/prod/          # replicas=2, Gateway/HTTPRoute, prod env
```

Why this answers the reliability/flexibility concern:

- **Blast radius**: an apply in `50-edge` cannot touch the database or the cluster. Day-to-day changes live in one small stack with a small, fast plan.
- **State stays healthy**: cross-stack references go through `terraform_remote_state` outputs (read-only). Refactors within a stack use `moved` blocks; adopting existing resources uses `import` blocks — no hand-run `state mv` surgery in the normal path.
- **Scaling out is instantiation, not rewrite**: stacks call modules with variables. When prod deserves its own GCP project/cluster later, that is `stacks/prod-foundation`, `stacks/prod-cluster`, … reusing the same modules — beta keeps running untouched.
- **Ordering is explicit**: the numeric prefix is the dependency order (`00 → 50`); CI applies changed stacks in order. Deliberately **no Terragrunt** — six stacks don't justify another tool; plain `tofu -chdir` in CI does it. Revisit only if stack count multiplies. <!-- ponytail: plain tofu, Terragrunt when stacks × envs actually explode -->

"No manual ops": stacks apply from CI; the only human bootstrap is `00-bootstrap` (run locally once, its own tiny state then migrated to the bucket it created) and pasting initial secrets (Atlas API key, Auth0 client secrets, Tailscale OAuth, Cloudflare token) into Secret Manager.

### 7.3 CI/CD (GitHub Actions, keyless via Workload Identity Federation — no downloaded SA keys)

| Trigger        | Pipeline                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| PR             | lint + test (go test, tsc, eslint) + `tofu plan`                                                                              |
| merge → `main` | build/push API image → `kubectl apply -k overlays/beta`; web build → beta nginx image; `tofu apply` (infra changes)           |
| tag `v*`       | same image promoted to prod overlay; web build → `gsutil rsync` to bucket + CDN cache invalidation                            |
| mobile         | EAS Build (store binaries) + EAS Update (OTA JS) — `beta` channel points at the tailnet API, `prod` channel at the public API |

Beta mobile testers install the Tailscale app on their phone and join the tailnet — that is the price of "beta not exposed to public"; document it in the README.

### 7.4 Monitoring

The app emits OTLP (section 4.8), so the cluster only needs somewhere to send it:

- **beta**: one `grafana/otel-lgtm` pod in the beta namespace, Grafana reachable over the tailnet — full traces/metrics/logs with zero external services.
- **prod**: a small OTel Collector deployment; exporter pointed at the chosen backend — HyperDX, OpenObserve, or Grafana Cloud (all OTLP-native) — decided at the infra phase, app unchanged either way.
- One uptime check on `api.…/healthz` + alert; stdout JSON logs still land in Cloud Logging via GKE as a fallback.

### 7.5 Cost (monthly, rough)

| Item                                                                        | USD                              |
| --------------------------------------------------------------------------- | -------------------------------- |
| Atlas M10                                                                   | ~60                              |
| GKE Autopilot pods (2× api, 2× valkey, nginx, ts-operator ≈ 1.5 vCPU/3 GiB) | ~45                              |
| Autopilot mgmt fee                                                          | 0 (free tier covers one cluster) |
| Global ALB (1 forwarding rule) + CDN                                        | ~20                              |
| Cloud NAT                                                                   | ~35                              |
| PSC endpoint                                                                | ~8                               |
| KMS/DNS/Registry/Secret Manager                                             | ~5                               |
| Auth0, Tailscale (personal), EAS free tiers                                 | 0                                |
| **Total**                                                                   | **~$170**                        |

Cheapest lever if that stings: public-node cluster drops NAT (~$35) at a security-posture cost.

**This bill starts at zero**: development is local-first (see section 9); cloud infra is provisioned in the last phase, right before publishing, so nothing burns money while the apps are being built.

## 8. Security summary

- No secrets in code or CI (WIF, Secret Manager, Workload Identity).
- JWT verified per request; authorization is ownership checks in handlers (employer routes assert `owner_user_id == caller`).
- Sensitive fields (locations, phone, rates, anchors) encrypted at rest via KEK/DEK on top of Atlas's own disk encryption; per-env KMS keys; crypto-shredding deletes.
- Hourly rate never leaves employer-scoped endpoints.
- Beta fully private behind tailnet; Atlas has no public IP allow-list entries (PSC only).
- Rate limiting on mutation endpoints (Valkey).
- Anti-spoof: mock flag, accuracy gate, staleness gate, server-side distance, speed anomaly flags. Attestation (Play Integrity / App Attest) is the known next step and the only real answer to determined spoofers.

## 9. Local development (cloud-free)

Everything runs locally except Auth0 (SaaS — the beta tenant works from localhost with `http://localhost:*` callback URLs, free tier). The API contract in section 4.2 is the coordination point that lets all four projects proceed in parallel.

```yaml
# docker-compose.yml (repo root)
services:
  mongo:
    image: mongo:8
    ports: ["27017:27017"]
  valkey:
    image: valkey/valkey:8-alpine
    ports: ["6379:6379"]
  lgtm: # full OTel backend: Collector + Tempo + Loki + Prometheus + Grafana
    image: grafana/otel-lgtm
    ports: ["3000:3000", "4317:4317", "4318:4318"]
```

- **Backend**: `go run ./cmd/api` with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Traces/metrics/logs appear in Grafana at `localhost:3000` (admin/admin) from day one — the exact same OTLP pipeline as prod.
- **Crypto without KMS**: the envelope package has two `KeyWrapper` implementations — `kms` (prod/beta) and `local` (a static 32-byte key from `.env`, gitignored). Same DEK/ciphertext code path, so local data exercises the real encryption logic. This is the one interface in the backend, justified by two real implementations.
- **Web**: `vite dev` with a proxy to `localhost:8080`. Google Maps API key in `.env` (gitignored) — the one cloud thing needed before the infra phase: create the key by hand in the GCP console early (dev traffic sits inside the free tier), then move it under tofu management at phase 4.
- **Mobile**: Expo dev client; API base URL points at the machine's LAN IP (env-driven). Location features test fine locally — the simulator can simulate coordinates, and a real device on the same Wi-Fi covers the mock-detection path.
- **Seed script**: `backend/cmd/seed` creates a demo employer, members, and a week of entries so the web calendar/table have data without tapping through the mobile app.

## 10. Build order

Local-first: infra is deliberately last so no cloud cost accrues while the product is being built. Contract-first: section 4.2 is frozen early so backend, mobile, and web proceed simultaneously.

1. **Foundations** — repo scaffolding, docker-compose, backend skeleton (fx, Echo, otelx, envelope crypto with local wrapper), Auth0 beta tenant, seed script.
2. **Parallel build** (against local stack):
   - **Backend**: `/me`, employers/members, clock-in/out + proximity rules, entries, tips/report. Unit tests for geo + crypto + tip math.
   - **Mobile**: Auth0, clock screen with employer sheet + distance badge, history, outbox sync.
   - **Web**: Auth0, onboarding with Google Maps anchor picker, employees, calendar, table + tips.
3. **Pings + polish** — background tracking, report CSV, verified badges, empty states.
4. **Infra** — tofu stacks 00→50, CI/CD wiring, deploy beta (tailnet), smoke test end-to-end on real devices.
5. **Publish** — prod deploy, store submissions (EAS), OTel prod backend decision.
6. **Hardening** — Play Integrity/App Attest, alerting, backup-restore drill, load sanity check.

## 11. Decisions log (from design review)

1. **Domain**: `duckos.ai`, DNS on **Cloudflare** — hosts `clockit.duckos.ai` (web) and `api.clockit.duckos.ai` (API), grey-cloud records to the GCP LB, certs via Certificate Manager DNS authorization.
2. **Region**: users on both coasts (Vancouver/NYC) → `us-central1` for GCP + Atlas (regions must match for PSC).
3. **Anchor map picker**: Google Maps JS API — we're on GCP anyway, easy setup, most reliable; free tier covers this traffic. Key restricted by referrer + API.
4. **Money visibility**: employees see nothing money-related in v1 (rates *and* tip shares stay employer-only). Employee earnings view is a possible later feature pending feedback — the data model already supports it.
5. **Removed employees**: historical entries remain visible to the employer; entries are immutable records.
6. **Infra timing**: local-first development; provision cloud only at phase 4.
7. **Observability**: full OTel (traces + metrics + logs) in the Go backend from day one; `grafana/otel-lgtm` locally. Prod backend shortlist: **HyperDX, OpenObserve, or Grafana Cloud** — all OTLP-native, final pick at the infra phase (a collector exporter setting, no app change).
