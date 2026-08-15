# Phase 1: Foundations & Backend Skeleton

## Context

Design: `docs/design.md` §2 (repo layout), §3 (auth), §4.1 (backend structure), §4.4 (KEK/DEK), §4.8 (OTel), §9 (local dev).

Deliverable: a running Go API skeleton (`/healthz` only) with fx wiring, config, Mongo/Valkey clients, full OTel pipeline visible in local Grafana, envelope crypto with `local` + `kms` key wrappers, and Auth0 JWT middleware — plus the docker-compose local stack. No business endpoints yet (phase 2).

**Dependencies**: none. **Manual prerequisite** (human, not agent): an Auth0 tenant with a `clockit-api` API (audience `https://api.clockit.setthasit.dev`, RS256) and the `email`/`email_verified` custom-claims Action per design §3. The agent only needs `AUTH0_DOMAIN` + `AUTH0_AUDIENCE` env values; tests use a generated RSA key, not Auth0.

## Tasks

- [x] Task 1: Repository scaffold
  - [x] 1.1: Create monorepo directories and root files
  - [x] 1.2: Create `docker-compose.yml` and `.env.example`
- [x] Task 2: Go module and configuration
  - [x] 2.1: Init module, add `Makefile`, `.golangci.yml`
  - [x] 2.2: Implement `internal/config`
- [x] Task 3: HTTP server skeleton with fx
  - [x] 3.1: Implement `internal/httpx` (Echo, middleware, `/healthz`)
  - [x] 3.2: Implement `cmd/api/main.go` fx app
- [x] Task 4: Observability (`internal/otelx`)
  - [x] 4.1: Providers + exporters + fx lifecycle
  - [x] 4.2: slog fanout handler (stdout JSON + OTLP)
- [x] Task 5: Data clients
  - [x] 5.1: `internal/mongox` client provider
  - [x] 5.2: `internal/valkeyx` client provider
- [x] Task 6: Envelope crypto (`internal/crypto`)
  - [x] 6.1: `KeyWrapper` with `local` and `kms` implementations
  - [x] 6.2: `Seal`/`Open` AES-256-GCM + DEK cache
  - [x] 6.3: Unit tests
- [x] Task 7: Auth middleware (`internal/auth`)
  - [x] 7.1: JWKS-backed JWT validation, identity in context
  - [x] 7.2: Unit tests with generated RSA key
- [x] Task 8: Container & CI
  - [x] 8.1: `backend/Dockerfile`
  - [x] 8.2: `.github/workflows/ci.yml`
- [x] Task 9: Verification

## Implementation Details

### Task 1: Repository scaffold

#### 1.1: Create monorepo directories and root files

Create empty dirs with `.gitkeep`: `mobile/`, `web/`, `infra/`. `backend/` gets real content below. Root `.editorconfig` (utf-8, lf, 2-space default, tabs for Go).

#### 1.2: docker-compose and env example

**File**: `docker-compose.yml`

```yaml
services:
  mongo:
    image: mongo:8
    ports: ["27017:27017"]
    volumes: [mongo-data:/data/db]
  valkey:
    image: valkey/valkey:8-alpine
    ports: ["6379:6379"]
  lgtm:
    image: grafana/otel-lgtm
    ports: ["3000:3000", "4317:4317", "4318:4318"]
volumes:
  mongo-data:
```

**File**: `backend/.env.example`

```sh
HTTP_ADDR=:8080
MONGO_URI=mongodb://localhost:27017
MONGO_DB=clockit_local
VALKEY_ADDR=localhost:6379
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://api.clockit.setthasit.dev
KEK_MODE=local                # local | kms
KEK_LOCAL_KEY=                # base64 32 bytes; generate: openssl rand -base64 32
KMS_KEY_NAME=                 # projects/.../cryptoKeys/kek-beta (kms mode only)
OTEL_SERVICE_NAME=clockit-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=local
MAX_ACCURACY_M=100
MAX_CLOCK_SKEW=5m
ANCHOR_RADIUS_M=1000
SPEED_ANOMALY_KMH=200
```

### Task 2: Go module and configuration

#### 2.1: Module, Makefile, lint config

**Files**: `backend/go.mod`, `backend/Makefile`, `backend/.golangci.yml`

`go mod init github.com/<owner>/clockit/backend` (match the GitHub remote owner; check `git remote get-url origin`). Go version: current stable installed locally (`go version`).

Dependencies added as tasks need them; core set: `github.com/labstack/echo/v4`, `go.uber.org/fx`, `go.mongodb.org/mongo-driver/v2`, `github.com/valkey-io/valkey-go`, `github.com/golang-jwt/jwt/v5`, `github.com/MicahParks/keyfunc/v3`, `cloud.google.com/go/kms`, OTel SDK + contrib packages listed in design §4.8.

Makefile targets:

```makefile
run:   ## go run with .env loaded
	set -a && . ./.env && set +a && go run ./cmd/api
test:
	go test ./...
lint:
	golangci-lint run
seed:
	set -a && . ./.env && set +a && go run ./cmd/seed
```

`.golangci.yml`: default linters + `govet`, `errcheck`, `staticcheck`; nothing exotic.

#### 2.2: Config package

**File**: `backend/internal/config/config.go`

Plain struct, `Load()` reads env vars with defaults (stdlib `os.Getenv` + small helpers; no viper). Fields mirror `.env.example` exactly, typed (`time.Duration` for `MAX_CLOCK_SKEW`, ints for meters/kmh). `Load()` returns error on missing required values (`MONGO_URI`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`; `KEK_LOCAL_KEY` required iff `KEK_MODE=local`, `KMS_KEY_NAME` iff `kms`).

### Task 3: HTTP server skeleton

#### 3.1: Echo server

**File**: `backend/internal/httpx/server.go`

```go
func NewEcho(cfg config.Config) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Recover())
	e.Use(otelecho.Middleware("clockit-api")) // traces + http metrics
	e.HTTPErrorHandler = ErrorHandler         // maps apperr -> error contract JSON
	e.GET("/healthz", func(c echo.Context) error { return c.NoContent(http.StatusOK) })
	return e
}
```

**File**: `backend/internal/httpx/errors.go` — the error contract from `document/clockit/README.md`:

```go
type AppError struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}
func (e *AppError) Error() string { return e.Code + ": " + e.Message }
```

`ErrorHandler` renders `{"error": {...}}` for `*AppError`, falls back to 500 `INTERNAL` (never leaks internals), and records the error on the active span.

#### 3.2: fx main

**File**: `backend/cmd/api/main.go`

```go
func main() {
	fx.New(
		fx.Provide(config.Load, httpx.NewEcho, mongox.New, valkeyx.New, crypto.NewEnvelope, auth.NewMiddleware),
		fx.Invoke(otelx.Setup, httpx.Start), // Start registers lifecycle OnStart/OnStop for e.Start/e.Shutdown
	).Run()
}
```

`httpx.Start(lc fx.Lifecycle, e *echo.Echo, cfg config.Config)` starts the server in OnStart (goroutine, `e.Start(cfg.HTTPAddr)`) and calls `e.Shutdown(ctx)` in OnStop. Phase 2 appends domain modules to this constructor list — keep it a flat list, no fx.Module ceremony.

### Task 4: Observability

#### 4.1: Providers

**File**: `backend/internal/otelx/otel.go`

`Setup(lc fx.Lifecycle, cfg config.Config) error`:
- `resource.New` with `semconv.ServiceName(cfg.OTelServiceName)` (env `OTEL_RESOURCE_ATTRIBUTES` is merged automatically by the SDK's env detector).
- Trace: `otlptracehttp.New` → `sdktrace.NewTracerProvider` → `otel.SetTracerProvider`.
- Metric: `otlpmetrichttp.New` → `sdkmetric.NewMeterProvider` (PeriodicReader) → `otel.SetMeterProvider`; then start `runtime.Start()` (contrib runtime metrics).
- Log: `otlploghttp.New` → `sdklog.NewLoggerProvider` → `global.SetLoggerProvider`.
- Propagator: `otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))`.
- `lc.Append` OnStop: flush + shutdown all three providers (5s timeout).

Exporter endpoints come from standard `OTEL_EXPORTER_OTLP_ENDPOINT` env — pass no explicit endpoint options.

#### 4.2: slog fanout

**File**: `backend/internal/otelx/slog.go`

```go
// Fanout duplicates records to stdout JSON (kubectl logs) and OTLP (Loki via collector).
type fanout struct{ handlers []slog.Handler }
```

Implement the 4 `slog.Handler` methods delegating to all handlers. Build default logger:

```go
slog.SetDefault(slog.New(fanout{[]slog.Handler{
	slog.NewJSONHandler(os.Stdout, nil),
	otelslog.NewHandler("clockit-api"),
}}))
```

Called from `Setup` after the logger provider exists. Always pass `ctx` to log calls (`slog.InfoContext`) so trace correlation works.

### Task 5: Data clients

#### 5.1: Mongo

**File**: `backend/internal/mongox/client.go`

`New(lc fx.Lifecycle, cfg config.Config) (*mongo.Database, error)` — driver **v2** (`go.mongodb.org/mongo-driver/v2/mongo`), `options.Client().ApplyURI(cfg.MongoURI).SetMonitor(otelmongo.NewMonitor())` (check otelmongo v2 constructor name in its docs), ping on start, disconnect on stop. Returns the `*mongo.Database` for `cfg.MongoDB` — handlers/stores take the database, never the client.

#### 5.2: Valkey

**File**: `backend/internal/valkeyx/client.go`

`New(lc fx.Lifecycle, cfg config.Config) (valkey.Client, error)` using `valkeyotel.NewClient(valkey.ClientOption{InitAddress: []string{cfg.ValkeyAddr}})`. Close on stop.

### Task 6: Envelope crypto

#### 6.1: KeyWrapper

**File**: `backend/internal/crypto/wrapper.go`

```go
// KeyWrapper wraps/unwraps 32-byte DEKs. Two real implementations justify the interface (design §9).
type KeyWrapper interface {
	Wrap(ctx context.Context, dek []byte) ([]byte, error)
	Unwrap(ctx context.Context, wrapped []byte) ([]byte, error)
}
```

- `localWrapper`: AES-256-GCM with the static key from `KEK_LOCAL_KEY` (base64). Wrap = seal, Unwrap = open. Output format identical shape to a ciphertext blob (nonce‖ct).
- `kmsWrapper`: `cloud.google.com/go/kms/apiv1` client; `Encrypt`/`Decrypt` with `cfg.KMSKeyName`. Construct the client lazily only in `kms` mode.
- `NewKeyWrapper(cfg) (KeyWrapper, error)` switches on `KEK_MODE`.

#### 6.2: Envelope service

**File**: `backend/internal/crypto/envelope.go`

```go
type Envelope struct {
	wrapper KeyWrapper
	cache   *dekCache // key: tenant doc ID hex -> dek, TTL 15m, max 1024 entries
}

func (e *Envelope) NewDEK(ctx) (dek []byte, wrapped []byte, err error)      // rand 32B + Wrap
func (e *Envelope) UnwrapDEK(ctx, cacheKey string, wrapped []byte) ([]byte, error) // cache-aside
func Seal(dek, plaintext []byte) ([]byte, error)  // out: 0x01 || 12B nonce || ciphertext (GCM)
func Open(dek, blob []byte) ([]byte, error)       // rejects unknown version byte
```

`dekCache`: map + mutex + expiry timestamps, evict on read; measure `clockit.kms.unwrap.duration` histogram around wrapper.Unwrap. No external cache lib. <!-- ponytail: plain map+mutex; LRU lib if entries ever matter -->

Helpers used by phase 2: `SealJSON(dek, v any)` / `OpenJSON(dek, blob, &v)` (marshal + seal).

#### 6.3: Tests

**File**: `backend/internal/crypto/envelope_test.go`

- Seal→Open roundtrip; Open fails on: flipped ciphertext bit, wrong DEK, bad version byte, truncated blob.
- localWrapper roundtrip; Unwrap fails with wrong KEK.
- Cache: second UnwrapDEK does not call wrapper (count with a stub KeyWrapper).

### Task 7: Auth middleware

#### 7.1: JWT validation

**File**: `backend/internal/auth/jwt.go`

```go
type Identity struct{ Sub, Email string; EmailVerified bool }

func NewMiddleware(cfg config.Config) (echo.MiddlewareFunc, error)
func FromContext(c echo.Context) Identity // panics if middleware missing (programmer error)
```

- JWKS: `keyfunc.NewDefault([]string{"https://" + cfg.Auth0Domain + "/.well-known/jwks.json"})` (background refresh built in).
- Parse with `github.com/golang-jwt/jwt/v5`: `jwt.WithValidMethods([]string{"RS256"})`, `jwt.WithAudience(cfg.Auth0Audience)`, `jwt.WithIssuer("https://"+cfg.Auth0Domain+"/")`, `jwt.WithExpirationRequired()`.
- Custom claims struct reads namespaced claims the Auth0 Action sets: `https://clockit/email`, `https://clockit/email_verified`.
- Failure → 401 `UNAUTHENTICATED`. Success → store `Identity` in echo context (`c.Set`), add `user.sub` span attribute.
- Constructor takes an optional override (unexported field) so tests can inject a static key — simplest: export `NewMiddlewareWithKeyfunc(cfg, jwt.Keyfunc)` and have `NewMiddleware` call it.

#### 7.2: Tests

**File**: `backend/internal/auth/jwt_test.go`

Generate `rsa.GenerateKey`, mint tokens with `jwt.NewWithClaims(jwt.SigningMethodRS256, ...)`. Table tests: valid → 200 + identity present; expired, wrong audience, wrong issuer, `alg=none`, HS256-signed → 401.

### Task 8: Container & CI

#### 8.1: Dockerfile

**File**: `backend/Dockerfile`

Multi-stage: `golang:<current>-alpine` build (`CGO_ENABLED=0 go build -o /api ./cmd/api`) → `gcr.io/distroless/static-debian12:nonroot`, `USER nonroot`, `ENTRYPOINT ["/api"]`.

#### 8.2: CI workflow

**File**: `.github/workflows/ci.yml`

On PR + push to main, path-filtered job for `backend/**`: setup-go (version from `go.mod`), `go build ./...`, `go test ./...`, `golangci-lint-action`. Placeholder jobs for `web/**` and `mobile/**` are added in their phases — structure the workflow with per-project jobs and `paths` filters now.

### Task 9: Verification

- [x] 9.1: `docker compose up -d` succeeds; Grafana reachable at `localhost:3000`.
- [x] 9.2: `make run` starts; `curl localhost:8080/healthz` → 200; the request appears as a trace in Grafana (Tempo) and runtime metrics in Prometheus within ~1 min.
- [x] 9.3: `make test` and `make lint` pass.
- [x] 9.4: `docker build backend/` succeeds.

## Completion notes (2026-08-12)

Verified: healthz 200; `GET /healthz` trace in Tempo; `go_goroutine_count` + `http_server_request_duration_seconds` in Prometheus with `deployment_environment=local`; tests + lint green; image builds.

Deviations from plan snippets (per README rule):

- `.golangci.yml`: installed golangci-lint is v2.5 — config is `version: "2"` only; v2 defaults already = errcheck, govet, ineffassign, staticcheck, unused (the plan's list).
- `resource.New` needs explicit `resource.WithFromEnv()` to merge `OTEL_RESOURCE_ATTRIBUTES` — the SDK env detector is not automatic with `resource.New` (only with `resource.Default()`).
- CI: GitHub has no native job-level path filters in a single workflow → `dorny/paths-filter` gate job feeding per-project jobs; `golangci-lint-action@v8` (required for golangci v2).
- `ErrorHandler` also maps `*echo.HTTPError` (router 404/405) to the error contract with status preserved (`NOT_FOUND`, …) instead of collapsing to 500 INTERNAL; unknown errors still → 500 INTERNAL.
- Auth0: middleware provider is lazy (fx) — nothing consumes it in phase 1, so `make run` works with placeholder `AUTH0_DOMAIN`. Real tenant values needed when phase 2 mounts routes. Mongo/valkey providers likewise constructed on first consumer (phase 2).
