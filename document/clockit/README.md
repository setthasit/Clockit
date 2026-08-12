# ClockIt — Implementation Plans

Execution order and agent mapping. The authoritative design is [`docs/design.md`](../../docs/design.md) — every phase references its sections. Read the referenced design sections before executing a phase.

| Phase | File | Executor agent | Depends on |
|---|---|---|---|
| 1 | `phase-1-foundations.md` | go-code-writer | — |
| 2 | `phase-2-backend-api.md` | go-code-writer | 1 |
| 3 | `phase-3-mobile-app.md` | rn-code-writer | 2 (API running locally) |
| 4 | `phase-4-web-app.md` | react-code-writer | 2 (API running locally) |
| 5 | `phase-5-pings-and-polish.md` | rn-code-writer + go-code-writer | 3, 4 |
| 6 | `phase-6-infra-deploy.md` | general | 2–5 (deployable artifacts) |

Phases 3 and 4 are independent of each other and can run in parallel once phase 2 is done.

## Global conventions (apply to every phase)

- **Money**: integer cents. **Time**: UTC ISO-8601 strings over the wire; employer `timezone` (IANA) defines day boundaries for tips/reports.
- **IDs**: MongoDB ObjectID hex strings over the wire; client-generated idempotency keys are UUIDv4 in `client_id`.
- **Accent color**: `#00286E` (both frontends).
- **No barrel files** (no `index.ts` re-export hubs), no speculative interfaces/abstraction layers. One package/module per domain concern.
- **Error contract** (backend → clients):

```json
{ "error": { "code": "OUT_OF_RANGE", "message": "1.8 km from Acme Cafe", "details": { "distance_m": 1800 } } }
```

- **Validation constants** (env-overridable, defaults): `MAX_ACCURACY_M=100`, `MAX_CLOCK_SKEW=5m`, `ANCHOR_RADIUS_M=1000`, `SPEED_ANOMALY_KMH=200`.
- Never log or return: hourly rates (outside employer-owned routes), decrypted coordinates, phone numbers, DEKs.
- If a library API doesn't match what a plan shows, check the library's current docs and adapt — do not force outdated snippets. Note deviations in the phase's completion notes.

## Local run (once phase 1 done)

```sh
docker compose up -d          # mongo :27017, valkey :6379, otel-lgtm :3000/:4317/:4318
cd backend && make run        # API on :8080
cd backend && make seed       # demo employer + members + a week of entries
```
