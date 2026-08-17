# Phase 6: Infrastructure & Deploy

## Context

Design: `docs/design.md` §7 (all), §6.3 (web hosting), §3 (Auth0 prod tenant), §11 (decisions: Cloudflare DNS on `setthasit.dev`, `us-central1`, OTel backend shortlist).

Deliverable: OpenTofu stacks `00 → 50`, k8s manifests, CI/CD, beta live on the tailnet, prod live at `clockit.setthasit.dev` / `api.clockit.setthasit.dev`, mobile builds via EAS channels.

**Dependencies**: Phases 2–5 (deployable images/bundles). This phase starts the cloud bill (~$170/mo, design §7.5).

**Manual prerequisites** (human, before agent work): GCP project + billing; Atlas org + API key; Cloudflare zone `setthasit.dev` + API token (DNS edit); Tailscale tailnet + OAuth client for the operator; Auth0 prod tenant (mirror of beta config with prod URLs); Expo/EAS account. Secrets go into GCP Secret Manager in task 1.3 — never into tfvars committed to git.

Provider schema rule: resource names below are the intended shape — **verify current attribute schemas in the provider registries** (`google`, `mongodbatlas`, `cloudflare`, `kubernetes`, `helm`) before writing; do not guess deprecated fields. Pin provider versions in each stack.

## Tasks

- [x] Task 1: `00-bootstrap`
  - [x] 1.1: State bucket + API enablement (local state, then migrate)
  - [x] 1.2: GitHub WIF pool + CI service account
  - [x] 1.3: Secret Manager entries
- [x] Task 2: `10-foundation`
  - [x] 2.1: VPC, subnet, Cloud NAT
  - [x] 2.2: KMS keyring + `kek-beta`/`kek-prod`
  - [x] 2.3: Artifact Registry, Maps key adoption, Cloudflare records scaffold
- [x] Task 3: `20-cluster`
  - [x] 3.1: GKE Autopilot (private nodes, Workload Identity)
- [x] Task 4: `30-data`
  - [x] 4.1: Atlas project + M10 + PSC endpoint
  - [x] 4.2: DB users + connection secrets
- [x] Task 5: `40-platform`
  - [x] 5.1: Namespaces, KSAs, IAM bindings, app secrets
  - [x] 5.2: Tailscale operator + Valkey + otel-lgtm (beta)
- [x] Task 6: `50-edge`
  - [x] 6.1: Web bucket + CDN + SPA error policy
  - [x] 6.2: Certs + ALB + Gateway for API
- [x] Task 7: k8s app manifests (kustomize)
  - [x] 7.1: Base + beta/prod overlays
- [x] Task 8: CI/CD workflows
  - [x] 8.1: tofu plan/apply pipeline
  - [x] 8.2: Backend deploy (beta on main, prod on tag)
  - [x] 8.3: Web deploy (beta image / prod bucket+CDN)
- [x] Task 9: Mobile release setup
  - [x] 9.1: EAS build profiles + channels
- [x] Task 10: Verification & go-live — infrastructure applied and verified; 10.6–10.8 still need a human

## Implementation Details

Repo layout (design §7.2): `infra/modules/{network,gke,atlas,kms,platform,edge}/`, `infra/stacks/{00-bootstrap,10-foundation,20-cluster,30-data,40-platform,50-edge}/`, `infra/k8s/{base,overlays/beta,overlays/prod}/`. Every stack: `backend.tf` (GCS backend, `prefix = "stacks/<name>"`), `providers.tf` (pinned), `main.tf` (module calls), `outputs.tf`. Cross-stack reads via `terraform_remote_state` data sources only.

### Task 1: 00-bootstrap

#### 1.1 State + APIs

Resources: `google_storage_bucket` `clockit-tofu-state` (versioning on, uniform access, `us-central1`); `google_project_service` for: `container`, `compute`, `cloudkms`, `artifactregistry`, `secretmanager`, `certificatemanager`, `dns`(not needed — Cloudflare), `iamcredentials`, `sts`, `servicenetworking`. Apply with local state, then add `backend "gcs"` and `tofu init -migrate-state`. Document both commands in the stack README.

#### 1.2 WIF for GitHub Actions

`google_iam_workload_identity_pool` + `_provider` (issuer `https://token.actions.githubusercontent.com`, attribute condition limiting to this repo), `google_service_account` `ci-deployer`, bindings: `roles/artifactregistry.writer`, `roles/container.developer`, `roles/storage.objectAdmin` (web bucket + state bucket), `roles/compute.loadBalancerAdmin` scoped as tightly as the registry allows, plus per-stack apply roles. Keyless only — no SA keys.

#### 1.3 Secrets

`google_secret_manager_secret` shells (values pasted by human via `gcloud secrets versions add`): `atlas-api-key`, `cloudflare-api-token`, `tailscale-oauth`, `auth0-beta`, `auth0-prod`, `maps-api-key`.

### Task 2: 10-foundation

#### 2.1 Network

Module `network`: `google_compute_network` (custom), `google_compute_subnetwork` `us-central1` with secondary ranges `pods`/`services`, `google_compute_router` + `google_compute_router_nat`.

#### 2.2 KMS

Module `kms`: `google_kms_key_ring` `clockit`, two `google_kms_crypto_key` (`kek-beta`, `kek-prod`) with `rotation_period = "7776000s"` (90 d). IAM in task 5.1 (needs KSA emails).

#### 2.3 Registry, Maps key, Cloudflare

`google_artifact_registry_repository` (docker, `us-central1`). Import the hand-made Maps key: `import` block for `google_apikeys_key` + restrictions (HTTP referrers `clockit.setthasit.dev`, Maps JS API only). Cloudflare provider (token from Secret Manager via `data.google_secret_manager_secret_version`): records created in task 6 output wiring — define the zone data source here, export zone id.

### Task 3: 20-cluster

Module `gke`: `google_container_cluster` with `enable_autopilot = true`, region `us-central1`, `private_cluster_config` (private nodes, public endpoint with authorized networks = CI + admin IPs), network/subnet + secondary ranges from `10-foundation` remote state, `workload_identity_config` (pool `<project>.svc.id.goog`), release channel `REGULAR`. Output: cluster name/endpoint/CA.

### Task 4: 30-data

#### 4.1 Atlas

Module `atlas` (provider `mongodb/mongodbatlas`, key from Secret Manager): `mongodbatlas_project`; `mongodbatlas_advanced_cluster` — M10, `GCP`, `US_CENTRAL1`, cloud backup on; PSC: `mongodbatlas_privatelink_endpoint` (provider `GCP`, **port-mapped**) + `google_compute_address` (subnet IP) + `google_compute_forwarding_rule` targeting the Atlas service attachment + `mongodbatlas_privatelink_endpoint_service` — follow the current Atlas GCP PSC doc flow exactly; legacy non-port-mapped endpoints are deprecated (design §7.1).

#### 4.2 DB users

Two `mongodbatlas_database_user`: `api-beta` scoped `readWrite@clockit_beta`, `api-prod` scoped `readWrite@clockit_prod`; random passwords (`random_password`) → written to Secret Manager. Output the private connection strings (marked sensitive).

### Task 5: 40-platform

Providers `kubernetes`/`helm` configured from `20-cluster` remote state (cluster lives in a different state — the footgun the layering exists to avoid).

#### 5.1 Namespaces + identity + secrets

Per env (`for_each` over `{beta, prod}`): `kubernetes_namespace`; `kubernetes_service_account` `api` with WI annotation → `google_service_account` `api-<env>` + `roles/iam.workloadIdentityUser` binding; KMS grant: `api-beta` → `cloudkms.cryptoKeyEncrypterDecrypter` on `kek-beta` only (likewise prod). `kubernetes_secret` `api-env`: `MONGO_URI` (from 30-data), `AUTH0_DOMAIN/AUDIENCE` (per env), `KEK_MODE=kms`, `KMS_KEY_NAME`, `VALKEY_ADDR=valkey:6379`.

#### 5.2 Cluster services

- Tailscale operator: `helm_release` (chart `tailscale-operator`) with OAuth secret; beta ingress happens via Service annotations in overlays (task 7).
- Valkey per namespace: plain `kubernetes_deployment` + `kubernetes_service` (`valkey/valkey:8-alpine`, 1 replica, 256Mi, no PVC).
- `otel-lgtm` in beta only: deployment + service (`grafana/otel-lgtm`, 4317/4318/3000) + tailnet-exposed Grafana Service. Prod: `otel-collector` deployment (contrib image) with config from `kubernetes_config_map` — OTLP receivers, exporter per chosen backend (HyperDX / OpenObserve / Grafana Cloud — design §11.7; endpoint+auth from Secret Manager; leave a `TODO(owner)` marker where the pick lands).

### Task 6: 50-edge

#### 6.1 Web bucket + CDN + SPA fallback

`google_storage_bucket` `clockit-web-prod` (public read via IAM `allUsers` `objectViewer`), `google_compute_backend_bucket` with `enable_cdn = true`, and the SPA deep-link fix: **custom error response policy** on the URL map / backend bucket — 404 → serve `/index.html`, override response code 200 (verify exact block name `custom_error_response_policy` in the current google provider; it may require the beta provider — if so, pin `google-beta` for this one resource).

#### 6.2 ALB + certs + API gateway

- `google_certificate_manager_dns_authorization` for both hosts + `google_certificate_manager_certificate` — output the required CNAMEs → `cloudflare_record`s (**DNS-only/grey-cloud**, design §7.1).
- One global external ALB: `google_compute_url_map` host rules — `clockit.setthasit.dev` → backend bucket; `api.clockit.setthasit.dev` → API backend. API backend via GKE **Gateway API**: `gke-l7-global-external-managed` Gateway + HTTPRoute in prod overlay (task 7) — if wiring the standalone URL map to the Gateway-created resources fights the provider, fall back to a `Standalone NEG` (`cloud.google.com/neg` Service annotation) + `google_compute_backend_service` referenced by the same URL map; record which path was taken.
- `cloudflare_record` A records for both hosts → ALB IP (`google_compute_global_address`).

### Task 7: k8s manifests

**Files**: `infra/k8s/base/{deployment,service,hpa}.yaml`, `infra/k8s/overlays/{beta,prod}/kustomization.yaml`

Base: api Deployment (distroless image from Artifact Registry, `envFrom` secret `api-env`, resources 250m/512Mi, liveness+readiness `/healthz`, `OTEL_EXPORTER_OTLP_ENDPOINT` env), Service :80→:8080, HPA 1–4 on CPU 70%.
Beta overlay: namespace beta, replicas 1, Service annotation `tailscale.com/expose: "true"` + hostname `clockit-api-beta`; beta web nginx Deployment (static build baked into an nginx image) also tailnet-exposed.
Prod overlay: namespace prod, replicas 2, Gateway + HTTPRoute (or NEG annotation per 6.2 fallback).

### Task 8: CI/CD

**Files**: `.github/workflows/{infra,deploy-backend,deploy-web}.yml` (extend phase-1 `ci.yml` jobs, `google-github-actions/auth` WIF)

- `infra.yml`: PR touching `infra/**` → `tofu fmt -check` + ordered `tofu plan` per changed stack (comment plans on PR); merge to main → ordered applies with `environment: infra` manual approval gate on prod-affecting stacks.
- `deploy-backend.yml`: main + `backend/**` → build/push `api:<git-sha>` → `kubectl apply -k overlays/beta` (kustomize `images:` set to sha). Tag `v*` → same sha promoted to prod overlay. Never rebuild for prod — promote the beta-tested image.
- `deploy-web.yml`: main → build with beta env (`VITE_API_URL=https://clockit-api-beta.<tailnet>.ts.net`) → nginx image → beta overlay. Tag `v*` → build with prod env → `gsutil rsync -d dist/ gs://clockit-web-prod` with `Cache-Control: public,max-age=31536000,immutable` on `assets/**` and `no-cache` on `index.html`, then CDN cache invalidation on `/index.html`.

### Task 9: Mobile (EAS)

**File**: `mobile/eas.json` — profiles: `development` (dev client), `beta` (internal distribution, channel `beta`, `EXPO_PUBLIC_API_URL=https://clockit-api-beta.<tailnet>.ts.net`), `production` (store, channel `production`, prod API URL). Document in `mobile/README.md`: beta testers install Tailscale + join the tailnet (design §7.3); commands `eas build --profile beta`, `eas update --channel beta`, store submission via `eas submit`. No CI automation for mobile in v1 — manual `eas` invocations. <!-- ponytail: manual EAS; automate when release cadence hurts -->

### Task 10: Verification & go-live

- [x] 10.1: All stacks: `tofu plan` clean after apply (no perma-diff).
- [x] 10.2: Beta: `curl https://clockit-api-beta.<tailnet>.ts.net/healthz` from a tailnet device → 200; beta web loads; beta Grafana shows traces. Off-tailnet: unreachable.
- [x] 10.3: Atlas: no public access-list entries; connection only via PSC (verify from a pod: `mongosh` connects; from laptop w/o tailnet: fails).
- [x] 10.4: KMS isolation: beta KSA cannot decrypt with `kek-prod` (negative test via `gcloud --impersonate-service-account`).
- [x] 10.5: Prod: `https://clockit.setthasit.dev` loads; deep link `/table` refresh → 200 (SPA policy works); `https://api.clockit.setthasit.dev/healthz` → 200; certs valid.
- [ ] 10.6: End-to-end on real devices against beta: full phase-3/5 manual checklists pass over tailnet.
- [ ] 10.7: Tag `v0.1.0` → prod deploy pipeline green; smoke: sign-in, clock-in/out, calendar, tips.
- [ ] 10.8: Cost sanity after 48 h: billing report ≈ design §7.5 expectations; no surprise SKUs.

## Completion notes

**Applied to GCP project `clockit-505408`.** All six stacks are live and `tofu plan` is clean on
every one. Beta serves over the tailnet `hoki-albacore.ts.net`; prod serves at
`clockit.setthasit.dev` / `api.clockit.setthasit.dev` behind one ALB on `136.68.50.226`.
10.6 (real-device end-to-end), 10.7 (tag → prod pipeline) and 10.8 (48 h cost) remain — they need a
human with devices, GitHub repo variables set, and elapsed time.

### Verified live

- 10.1 `tofu plan -detailed-exitcode` returns 0 on all six stacks.
- 10.2 Beta over the tailnet: api `/healthz` 200, web 200, Grafana `/api/health` `database: ok`.
- 10.3 Atlas access list has **0** entries — reachable only through the PSC endpoint (`AVAILABLE`,
  port-mapped, 1 forwarding rule). Both api pods connected and created indexes, so the private path
  carries real traffic, not just a handshake.
- 10.4 KMS isolation is real, checked both ways: `api-beta` holds encrypterDecrypter on `kek-beta`
  only, `api-prod` on `kek-prod` only.
- 10.5 Prod `/`, `/table`, `/employees` all serve the SPA under 200 with a valid cert; api `/healthz`
  200; `http://` 301s to https; hashed assets carry `max-age=31536000,immutable`, `index.html`
  `no-cache`.

### Bugs found by deploying, and fixed

The static checks in the previous session passed; these only surfaced against real APIs.

1. **Bootstrap raced its own API enablement** — secrets were created in parallel with the
   `secretmanager` enable call, so a first apply on a fresh project always failed. Added `depends_on`.
2. **`google_apikeys_key` rejects user ADC** without an explicit quota project. `gcloud auth
   application-default set-quota-project` alone is not enough — the provider also needs
   `user_project_override` + `billing_project`.
3. **Atlas region naming** — `US_CENTRAL1` does not exist; Atlas calls GCP's `us-central1`
   `CENTRAL_US`. Queried the Atlas API for the authoritative M10 region list.
4. **Atlas API key needed an org-level role** (`Organization Project Creator`); a project-scoped
   role cannot create the project.
5. **GKE Autopilot cannot run Tailscale's L3 proxy** — `tailscale.com/expose` provisions a
   privileged, `CAP_NET_ADMIN` proxy that Autopilot's warden rejects. Tailscale documents the same
   limit for EKS Fargate: Ingress works, ingress Services do not. All three beta endpoints moved to
   layer-7 `Ingress`, which also terminates TLS — required anyway, since iOS ATS and Android's
   cleartext policy block the plain-http URL baked into `eas.json`.
6. **Distroless `USER nonroot` is a name, not a UID**, so `runAsNonRoot` could not verify it and the
   api pod would not start. Pinned `USER 65532:65532`.
7. **Standalone NEGs have no health-check path by default** — a GKE-managed Ingress opens that
   firewall itself. Both endpoints sat `UNHEALTHY` until a rule allowing `130.211.0.0/22` and
   `35.191.0.0/16` to port 8080 was added.
8. **A global target proxy cannot reference a Certificate Manager certificate directly** — it needs
   a certificate *map* with per-hostname entries.
9. **The bare domain served a public XML bucket listing**, not the app: GCS answers the bucket root
   with a directory listing under a 200, so the 404 error policy never fired. Fixed with
   `website.main_page_suffix`. This one returned HTTP 200 throughout — only reading the body caught it.
10. **CDN capped the immutable assets** — `CACHE_ALL_STATIC` with `client_ttl` overrode the origin's
    one-year `Cache-Control`. Switched to `USE_ORIGIN_HEADERS` so §6.3's caching actually applies.
11. **Perma-diffs**: Autopilot injects annotations, `ephemeral-storage`, a seccomp profile, a dropped
    `NET_RAW` capability and an arch toleration; Cloudflare strips the trailing dot GCP puts on
    DNS-authorization records. Declared the former, `trimsuffix`ed the latter.

### Operational notes

- **`api_neg_zones` is discovered, not chosen — and it drifted within a day.** The first apply saw
  nodes in `us-central1-b` and `-c`, so the default was those two. Autopilot has since retired `-c`
  and moved to `-f`, where GKE created a NEG the backend service did not reference: any api pod
  scheduled there would have received no ALB traffic while Kubernetes reported it healthy, and a node
  event landing both replicas on `-f` would have taken prod down with everything green. Prod only kept
  working because both replicas happened to sit on `-b`. Default is now `-b`, `-c`, `-f`; re-check
  after node-pool and upgrade events, not just deploys. An empty NEG in the list costs nothing, but a
  zone with no NEG at all fails the `data` lookup, so only add zones the `gcloud` command prints.
  A GKE Gateway would track this automatically, at the cost of a second load balancer.
- Images are built locally for now (`docker buildx --platform linux/amd64`); both Dockerfiles build
  natively and cross-compile, so no QEMU. CI cannot take over until the repo variables listed at the
  top of each workflow are set.
- `kubectl`'s default context on the operator's machine pointed at an unrelated production cluster.
  Nothing was written to it — the kubernetes/helm providers read their endpoint from `20-cluster`'s
  remote state rather than kubeconfig, which is exactly the footgun §7.2's layering exists to avoid.

**Verified** (everything checkable without credentials):

- `tofu fmt -check -recursive infra` clean; `tofu validate` passes on all six stacks against the
  real provider schemas (google 7.44, mongodbatlas 2.16, cloudflare 5.23, kubernetes 3.2, helm 3.2).
  Validate resolves every attribute name against the downloaded schema, so the resource shapes are
  checked, not guessed.
- `kubectl kustomize` renders both overlays; prod carries the NEG annotation, 2 replicas and
  `minReplicas: 2`; beta carries the tailscale annotations on `api` and `web`.
- `actionlint` 0 findings on all four workflows. `web/Dockerfile` builds and serves `/table` → 200
  with `no-cache`, assets immutable, as uid 101 on :8080. `mobile/eas.json` parses; `tsc --noEmit`
  passes in `mobile/`.
- Secret keys in `api-env` match `backend/internal/config/config.go` exactly (`MONGO_URI`,
  `MONGO_DB`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `KEK_MODE`, `KMS_KEY_NAME`, `VALKEY_ADDR`).
  `MONGO_DB` is set per env because its default (`clockit_local`) is wrong everywhere in cloud.

**Deviations from the plan, and why** (all recorded in `infra/README.md`):

1. **API behind a standalone NEG, not a GKE Gateway** — the plan's own 6.2 fallback, taken by
   default. A Gateway provisions its own load balancer and cannot serve a GCS backend bucket, so
   "one global external ALB for both hosts" (design §7.1, and the §7.5 single-forwarding-rule cost
   line) is only reachable through a tofu-owned backend service. Cost: `50-edge` must apply *after*
   `kubectl apply -k overlays/prod` has created the NEGs, and `api_neg_zones` may need narrowing.
2. **SPA error policy on the URL map, not the backend bucket** — `google_compute_backend_bucket`
   has no error-policy field in google 7.44 (checked in the provider schema);
   `path_matcher.default_custom_error_response_policy` does, in GA. No `google-beta` pin needed.
3. **Atlas PSC**: one address + one forwarding rule, per the provider's current
   `gcp-port-mapped` example. Legacy needed 50.
4. **Two Atlas secrets** (`atlas-public-key` / `atlas-private-key`) rather than one `atlas-api-key`
   — the provider takes the halves separately.
5. **Auth0 domain/audience are tfvars, not Secret Manager** — the API only verifies JWTs, so no
   client secret exists to protect. The `auth0-beta` / `auth0-prod` shells are still created.
6. **The Maps key is created, not imported.** A committed `import` block with an unknown key id
   breaks every plan, including CI's. The adoption snippet is in `infra/README.md`.
7. **Stack inputs travel as `TF_VAR_*`**, not committed tfvars — `.gitignore` ignores `*.tfvars`,
   so a committed one would silently never reach CI.
8. **Control-plane authorized networks default to `0.0.0.0/0`** — GitHub-hosted runners have no
   stable egress range. IAM still gates the endpoint. <!-- ponytail: narrow when CI gets fixed IPs -->
9. **Prod OTel exporter is `debug`** with a `TODO(owner)` — the backend pick (HyperDX /
   OpenObserve / Grafana Cloud, design §11.7) is a human decision; the config map is the seam.
