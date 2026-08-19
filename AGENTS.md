# ClockIt — Agent Instructions

## Project conventions (override any generic/company patterns)

- **Backend (Go)**: flat domain packages (`internal/<domain>/{model,store,handler}.go`). Handlers call stores directly — **no service layer, no repository interfaces, no mock-generation frameworks**. Business rules are plain functions. Errors: `httpx.AppError` catalog (`internal/httpx/codes.go`) rendered as `{"error":{code,message,details}}` — do not introduce other error-wrapping schemes.
- **Frontends**: no barrel files (no re-export `index.ts`), no abstraction layers over fetch beyond the single `api.ts` wrapper per app. Accent color `#00286E`.
- **Money** = integer cents. **Wire time** = UTC ISO-8601; employer IANA timezone defines day boundaries.
- **IDs**: MongoDB ObjectID hex strings over the wire; client-generated idempotency keys are UUIDv4 in `client_id`.
- **Validation constants** (env-overridable, defaults): `MAX_ACCURACY_M=100`, `MAX_CLOCK_SKEW=5m`, `MAX_QUEUED_AGE=72h`, `ANCHOR_RADIUS_M=1000`, `SPEED_ANOMALY_KMH=200`.
- Never log or expose: hourly rates outside employer-owned routes, decrypted coordinates, phone numbers, DEKs.
- Prefer editing existing files; smallest diff that satisfies the task. Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and upgrade path.

## Commands

```sh
docker compose up -d                 # mongo, valkey, otel-lgtm (local stack)
cd backend && make run|test|lint|seed
cd web && npm run dev|build && npx tsc --noEmit
cd mobile && npx tsc --noEmit && npx expo-doctor
```

## Verification

Verification is part of the work, not optional. Backend changes need `make test && make lint` green; frontends need their typecheck and tests green. If a library API differs from what a doc shows, follow the library's current docs.
