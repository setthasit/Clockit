# Phase 2: Backend Domain APIs

## Context

Design: `docs/design.md` §4.2 (API), §4.3 (data model + indexes), §4.5 (location rules), §4.6 (tip split), §4.7 (Valkey), §11 (decisions).

Deliverable: the complete v1 API against local Mongo — every endpoint in design §4.2, with envelope-encrypted sensitive fields, proximity validation, idempotency, rate limiting, seed data, and tests. After this phase, mobile (phase 3) and web (phase 4) build against `localhost:8080` in parallel.

**Dependencies**: Phase 1 complete (fx skeleton, crypto, auth middleware, clients).

Conventions for all domain packages (`user`, `employer`, `entry`, `tip`):
- Files per package: `model.go` (structs + BSON tags), `store.go` (Mongo access, takes `*mongo.Database`), `handler.go` (Echo handlers + request validation + authz), optional domain logic files (`geo.go`, `split.go`).
- Handlers call stores directly. Business rules are plain functions. No service layer, no repositories-behind-interfaces.
- Every handler: get `auth.FromContext(c)` identity → resolve `*user.User` (JIT middleware below) → authz check → work → respond. Ownership failures return 404 (`NOT_FOUND`), not 403, to avoid resource-existence leaks.
- Encrypted fields are `[]byte` (BSON binData) named `*_enc`, sealed with `crypto.SealJSON` using the owning tenant's DEK per design §4.4 field mapping.
- Register routes in each package: `func RegisterRoutes(e *echo.Echo, h *Handler, authMW, userMW echo.MiddlewareFunc)`; wired from `main.go` via `fx.Invoke`.

## Tasks

- [x] Task 1: Shared plumbing
  - [x] 1.1: Index bootstrap (`internal/mongox/indexes.go`)
  - [x] 1.2: Error catalog (`internal/httpx/codes.go`)
  - [x] 1.3: Rate-limit middleware (`internal/valkeyx/ratelimit.go`)
- [x] Task 2: User domain
  - [x] 2.1: Model + store (JIT provisioning, membership claim)
  - [x] 2.2: User middleware + `GET/PATCH /v1/me`
  - [x] 2.3: Tests
- [ ] Task 3: Employer domain
  - [x] 3.1: Model + store
  - [x] 3.2: `POST/GET/PATCH /v1/employers`
  - [x] 3.3: Membership endpoints (add/list/rate/remove)
  - [ ] 3.4: Tests
- [ ] Task 4: Entry domain — geo rules
  - [ ] 4.1: `geo.go` (haversine + fix validation)
  - [ ] 4.2: Geo unit tests
- [ ] Task 5: Entry domain — endpoints
  - [ ] 5.1: Clock-in
  - [ ] 5.2: Clock-out
  - [ ] 5.3: List + assign-employer
  - [ ] 5.4: Pings (batch)
  - [ ] 5.5: Employer entries view
  - [ ] 5.6: Tests
- [ ] Task 6: Tip domain
  - [ ] 6.1: `split.go` (largest-remainder split) + unit tests
  - [ ] 6.2: Tips PUT/GET + report endpoint
  - [ ] 6.3: Tests
- [ ] Task 7: Custom telemetry
  - [ ] 7.1: Domain counters + span attributes
- [ ] Task 8: Seed command
  - [ ] 8.1: `cmd/seed/main.go`
- [ ] Task 9: Verification

## Implementation Details

### Task 1: Shared plumbing

#### 1.1: Index bootstrap

**File**: `backend/internal/mongox/indexes.go`

`EnsureIndexes(ctx, db)` invoked from fx OnStart. Exactly the design §4.3 list:

```go
users:        {auth0_sub: 1} unique; {email: 1} unique
employers:    {owner_user_id: 1}
memberships:  {employer_id: 1, email: 1} unique; {user_id: 1}
time_entries: {user_id: 1, client_id: 1} unique
              {user_id: 1} unique partial on {status: "open"}
              {employer_id: 1, "clock_in.at": 1}; {user_id: 1, "clock_in.at": 1}
location_pings: {entry_id: 1, at: 1}; {created_at: 1} TTL 90d
tips:         {employer_id: 1, date: 1} unique
```

#### 1.2: Error catalog

**File**: `backend/internal/httpx/codes.go`

Constructors returning `*AppError` (status, code): `Unauthenticated` 401, `NotFound` 404, `Invalid` 400 `INVALID_ARGUMENT`, `MockedLocation` 422, `LowAccuracy` 422, `StaleTimestamp` 422, `OutOfRange` 422 (details `distance_m`, `limit_m`), `OpenEntryExists` 409, `NoOpenEntry` 409, `EmailNotVerified` 403, `RateLimited` 429. Clients key UX off `code` — never change codes without updating both frontends.

#### 1.3: Rate limiting

**File**: `backend/internal/valkeyx/ratelimit.go`

Fixed-window counter, key `rl:{sub}:{routePath}:{unixMinute}`: `INCR` + `EXPIRE 60` on first hit; over limit → `RateLimited`. <!-- ponytail: fixed window; sliding window if bursts at boundaries ever matter --> Applied in phase-2 route registration to mutation endpoints only, default 30/min/user (env `RATE_LIMIT_PER_MIN`). Valkey down → allow and log (availability over rate limiting for v1).

### Task 2: User domain

#### 2.1: Model + store

**File**: `backend/internal/user/model.go`

```go
type User struct {
	ID         bson.ObjectID `bson:"_id,omitempty"`
	Auth0Sub   string        `bson:"auth0_sub"`
	Email      string        `bson:"email"`
	Name       string        `bson:"name"`
	PhoneEnc   []byte        `bson:"phone_enc,omitempty"`
	DEKWrapped []byte        `bson:"dek_wrapped"`
	CreatedAt  time.Time     `bson:"created_at"`
}
```

**File**: `backend/internal/user/store.go`

- `GetOrCreate(ctx, ident auth.Identity) (*User, error)`: find by `auth0_sub`; on miss create with fresh DEK (`envelope.NewDEK`) — use `FindOneAndUpdate` upsert with `$setOnInsert` to be race-safe. On every call, if `ident.EmailVerified`, claim invitations: `memberships.UpdateMany({email: ident.Email, user_id: null}, {$set: {user_id, status: "active"}})`.
- `Update(ctx, id, name *string, phoneEnc []byte)`.

#### 2.2: Middleware + handlers

**File**: `backend/internal/user/handler.go`

- `Middleware(store)`: runs after auth MW; loads/creates the user, `c.Set("user", u)`. Exported `CurrentUser(c)` helper for all other packages.
- `GET /v1/me` → `{user: {id, email, name, has_phone}, memberships: [{id, status, employer: {id, name, anchor: {lat, lng}, timezone}}]}`. Anchor is decrypted with each employer's DEK (join via employer store) — members are entitled to see the clock-in zone (design §4.2). Never include `hourly_rate_cents`.
- `PATCH /v1/me` body `{name?, phone?}`; phone sealed with the user's DEK.

#### 2.3: Tests

**File**: `backend/internal/user/handler_test.go` — use a real local Mongo (`MONGO_URI` env in tests, `t.Skip` if unset), unique DB name per run, drop on cleanup. Cover: JIT creation is idempotent (2 parallel calls, 1 doc), invitation claiming on verified email, unverified email does not claim.

### Task 3: Employer domain

#### 3.1: Model + store

**File**: `backend/internal/employer/model.go`

```go
type Employer struct {
	ID          bson.ObjectID `bson:"_id,omitempty"`
	OwnerUserID bson.ObjectID `bson:"owner_user_id"`
	Name        string        `bson:"name"`
	Timezone    string        `bson:"timezone"`  // IANA, validated with time.LoadLocation
	AnchorEnc   []byte        `bson:"anchor_enc"` // SealJSON({lat, lng}) with employer DEK
	DEKWrapped  []byte        `bson:"dek_wrapped"`
	CreatedAt   time.Time     `bson:"created_at"`
}

type Membership struct {
	ID                 bson.ObjectID  `bson:"_id,omitempty"`
	EmployerID         bson.ObjectID  `bson:"employer_id"`
	Email              string         `bson:"email"` // lowercased
	UserID             *bson.ObjectID `bson:"user_id,omitempty"`
	Status             string         `bson:"status"` // invited|active|removed
	HourlyRateCentsEnc []byte         `bson:"hourly_rate_cents_enc,omitempty"` // employer DEK
	CreatedAt          time.Time      `bson:"created_at"`
}
```

Store helper used by every employer-scoped handler: `GetOwned(ctx, employerID, ownerUserID) (*Employer, error)` → `NotFound` if no match.

#### 3.2: Employer endpoints

`POST /v1/employers` `{name, anchor: {lat, lng}, timezone}` (validate lat ∈ [-90,90], lng ∈ [-180,180], tz loads) → new DEK, seal anchor. `GET /v1/employers` (mine, by owner). `PATCH /v1/employers/{id}` (name/anchor/timezone; re-seal anchor).

#### 3.3: Membership endpoints

- `POST /v1/employers/{id}/members` `{email}`: lowercase; insert `status: invited`; **immediate claim**: if a verified user with that email exists, set `user_id` + `active`. Duplicate (unique index) → 409 `ALREADY_MEMBER`. If a `removed` membership exists for the email, revive it (set `invited`/`active`) instead of inserting.
- `GET .../members` → include `email, status, joined user name (if linked), hourly_rate_cents` (decrypt; this is the employer-owned route — allowed).
- `PATCH .../members/{mid}` `{hourly_rate_cents}` (int ≥ 0, seal with employer DEK).
- `DELETE .../members/{mid}` → `status: removed` (soft; historical entries untouched per design §11.5).

#### 3.4: Tests

Ownership: non-owner gets 404 on every employer route. Rate never appears in any `/v1/me` payload (assert on JSON body). Add→claim→remove→re-add flow.

### Task 4: Entry geo rules

#### 4.1: geo.go

**File**: `backend/internal/entry/geo.go`

```go
type Fix struct{ Lat, Lng, AccuracyM float64; At time.Time; Mocked bool }

func haversineM(lat1, lng1, lat2, lng2 float64) float64 // R=6371000m, standard formula

// ValidateFix returns an *httpx.AppError or nil. anchor == nil skips the distance rule.
func ValidateFix(cfg config.Config, now time.Time, f Fix, anchor *LatLng) *httpx.AppError {
	// order: Mocked -> MockedLocation; AccuracyM > cfg.MaxAccuracyM -> LowAccuracy;
	// |now-f.At| > cfg.MaxClockSkew -> StaleTimestamp;
	// anchor != nil && haversineM(...) > cfg.AnchorRadiusM -> OutOfRange{distance_m, limit_m}
}
```

#### 4.2: Geo tests

Known-distance fixtures (e.g. two Vancouver coordinates ~1 km apart, verify ±1 m tolerance), boundary at exactly 1000 m passes, each rejection reason, rejection order (mocked wins over out-of-range).

### Task 5: Entry endpoints

#### model

**File**: `backend/internal/entry/model.go` — mirror design §4.3 `time_entries` + `location_pings`. `ClockPoint struct { At time.Time; LocEnc []byte; AccuracyM float64; Mocked bool }`. Location plaintext shape `{lat, lng}` sealed with the **user's** DEK.

#### 5.1: Clock-in — `POST /v1/entries/clock-in`

Body `{client_id, employer_id?, at, loc: {lat, lng, accuracy}, mocked}`.

1. Idempotency first: find by `(user_id, client_id)`; hit → return it, 200.
2. If `employer_id`: caller must hold an `active` membership (`NOT_MEMBER` 403 otherwise); load employer, decrypt anchor → validate with anchor. If no employer: validate with `anchor = nil` (fix becomes the anchor implicitly — clock-out reads it back).
3. Insert `status: "open"`, sealed location, `location_verified: employer_id != nil` (true only when the anchor rule actually ran and passed; personal entries get `true` as self-anchored). Duplicate-key on the partial open index → `OpenEntryExists`.
4. Respond 201 with the entry (decrypted `loc` echoed back to the owner).

#### 5.2: Clock-out — `POST /v1/entries/clock-out`

Body `{client_id, at, loc, mocked}`. Load open entry (`NoOpenEntry` 409 if none). Anchor = employer anchor if `employer_id` set, else the decrypted clock-in location. Validate; reject `at` ≤ clock-in `at` (`Invalid`). Set `clock_out`, `status: "closed"`. Idempotency: if the open entry is already closed and `client_id` matches the stored `close_client_id`, return it (store `close_client_id` on close).

#### 5.3: List + assign

- `GET /v1/entries?from&to` (RFC3339, filter on `clock_in.at`, own entries, sorted desc, decrypted locations included — owner sees own data).
- `PATCH /v1/entries/{id}` `{employer_id}`: only on own entry with `employer_id == nil`; must be active member. Re-check both fixes against the employer anchor → set `location_verified` accordingly; **never reject** (design §4.5.5). Assigning is one-way in v1 (un-assign not in scope).

#### 5.4: Pings — `POST /v1/pings`

Body `{pings: [{at, loc: {lat, lng, accuracy}}]}` (cap 64/batch). Attach to caller's open entry; silently accept-and-drop if none (shift may have closed before flush — don't error the outbox). Speed check between consecutive pings (previous ping or clock-in point): > `SPEED_ANOMALY_KMH` → `$addToSet` flag `speed_anomaly` on the entry. Store pings sealed with user DEK. Respond `{accepted: n}`.

#### 5.5: Employer entries — `GET /v1/employers/{id}/entries?from&to`

Owner-only. Entries where `employer_id = {id}`, joined with member name/email. Include `location_verified`, `flags`, duration minutes; **exclude raw coordinates** (employer sees verdicts, not tracks; pings stay employee-private in v1).

#### 5.6: Tests

Handler-level with real Mongo: idempotent clock-in replay; double clock-in → 409; out-of-range with distance in details; personal clock-in→out beyond 1 km → 422; assign-employer sets `location_verified=false` when out of range; pings ignored without open entry; employer entries hide coordinates.

### Task 6: Tips & report

#### 6.1: Split

**File**: `backend/internal/tip/split.go`

```go
// SplitByMinutes divides amountCents proportionally to minutes, largest-remainder rounding;
// returned shares sum exactly to amountCents. Deterministic tie-break: larger minutes first, then index.
func SplitByMinutes(amountCents int64, minutes []int64) []int64
```

Unit tests: `100/[30,30,30]` → `[34,33,33]`; zero total minutes → all zeros (tip stays unassigned in report); sum always exact under fuzz (few hundred random cases).

#### 6.2: Endpoints

- `PUT /v1/employers/{id}/tips/{date}` `{amount_cents ≥ 0}`, `date=YYYY-MM-DD` — upsert on unique index. `GET /v1/employers/{id}/tips?from&to`.
- `GET /v1/employers/{id}/report?from&to`: fetch closed entries in range (clock-in day computed **in employer timezone**; spanning-midnight entries count toward clock-in day, design §4.6), group by day × member. Per row: `minutes`, `hourly_rate_cents` (may be null), `base_pay_cents = round(rate*minutes/60)`, `tip_share_cents` from `SplitByMinutes` over that day's members, `total_cents`. Response grouped by day with day totals + the day's tip. Computed on read; nothing stored.

#### 6.3: Tests

Report fixture: 2 employees, known rates, one midnight-spanning entry, one tip day → assert exact cents. Timezone edge: entry at 23:30 local counts on its local day.

### Task 7: Custom telemetry

**File**: touched handlers + `backend/internal/entry/metrics.go`

Counters per design §4.8: `clockit.clock_in.total{result=ok|rejected}`, `clockit.proximity.rejected.total{reason}`, `clockit.outbox.sync.total{result}` (from `client_id` replays: label `result=replay` when idempotency hit). Span attributes on clock-in/out spans: `clockit.distance_m`, `clockit.accuracy_m`, `clockit.verdict`.

### Task 8: Seed

**File**: `backend/cmd/seed/main.go`

Flags: `-owner-sub`, `-owner-email`, `-employee-emails` (comma list). Creates owner user, employer "Acme Cafe" (anchor: pick fixed coords, tz `America/Vancouver`), active memberships with rates (1800¢/2200¢), 7 days of closed entries (7.5–9 h, one midnight-spanner, one `location_verified=false`, one `speed_anomaly`), tips on 3 days. Idempotent: deletes prior seed data by a `seed: true` marker field first. Prints the employer id + a summary table.

### Task 9: Verification

- [ ] 9.1: `make test` green (unit + Mongo-backed handler tests via compose).
- [ ] 9.2: `make lint` clean.
- [ ] 9.3: Manual smoke with `curl` + a real Auth0 token (get one from the Auth0 dashboard "Test" tab): me → create employer → add member → clock-in (in/out of range) → clock-out → report. Verify sealed fields in `mongosh` are binData, not plaintext.
- [ ] 9.4: Traces for clock-in show validation attributes; counters visible in local Grafana.
