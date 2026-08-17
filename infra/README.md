# ClockIt infrastructure

OpenTofu stacks (`00 → 50`), kustomize manifests, one GCP project, region `us-central1`.
Design: [`docs/design.md`](../docs/design.md) §7. Beta and prod are isolated by namespace, database, KMS key and service account inside one cluster.

```
modules/   network kms gke atlas platform edge     # pure, no backend/provider config
stacks/    00-bootstrap 10-foundation 20-cluster 30-data 40-platform 50-edge
k8s/       base + overlays/{beta,prod}
```

Each stack has its own state (`gs://clockit-tofu-state/stacks/<name>`) and reads its dependencies through `terraform_remote_state`. The numeric prefix is the apply order.

## Before anything (human, once)

GCP project + billing · Atlas org + API key · Cloudflare zone `setthasit.dev` + DNS-edit token · Tailscale tailnet + OAuth client · Auth0 prod tenant · Expo/EAS account.

`*.tfvars` is gitignored, so stack inputs travel as `TF_VAR_*` — exported locally, and set as GitHub repo **variables** for CI (none of them is a secret; secrets live in Secret Manager):

```sh
export TF_VAR_project_id=<gcp-project-id>          # every stack
export TF_VAR_github_repo=setthasit/Clockit        # 00-bootstrap
export TF_VAR_cloudflare_zone_id=<zone-id>         # 10-foundation (Cloudflare → setthasit.dev → Overview)
export TF_VAR_atlas_org_id=<org-id>                # 30-data (Atlas → Organization Settings)
export TF_VAR_auth0_beta_domain=<tenant>.us.auth0.com   # 40-platform
export TF_VAR_auth0_prod_domain=<tenant>.us.auth0.com   # 40-platform
```

## Bootstrap (local, once — the only manual apply)

`00-bootstrap` creates the bucket its own state will live in, so it starts local:

```sh
cd infra/stacks/00-bootstrap
tofu init && tofu apply
mv backend.tf.migrate backend.tf && tofu init -migrate-state
```

Then paste the secret values (shells were created empty):

```sh
printf %s "$VALUE" | gcloud secrets versions add atlas-public-key --data-file=-
# repeat for: atlas-private-key cloudflare-api-token tailscale-oauth-client-id
#             tailscale-oauth-client-secret auth0-beta auth0-prod maps-api-key
```

`00-bootstrap` outputs `workload_identity_provider` and `ci_service_account` — put them in the GitHub repo variables listed at the top of each workflow file.

## Apply order

```sh
for s in 10-foundation 20-cluster 30-data 40-platform; do tofu -chdir=infra/stacks/$s init && tofu -chdir=infra/stacks/$s apply; done
kubectl apply -k infra/k8s/overlays/prod     # creates the standalone NEGs 50-edge attaches to
tofu -chdir=infra/stacks/50-edge init && tofu -chdir=infra/stacks/50-edge apply
```

After the first apply, CI (`.github/workflows/infra.yml`) plans on PR and applies on merge.

**`50-edge` runs last on purpose.** Its API backend service attaches to the standalone NEGs that GKE creates when the prod Service is applied. Confirm which zones actually have one and set `api_neg_zones` if it is not all three:

```sh
gcloud compute network-endpoint-groups list --filter="name=clockit-api-prod"
```

## Decisions taken while implementing

- **API behind a standalone NEG, not a GKE Gateway** (plan task 6.2 fallback). A Gateway provisions its own load balancer, which cannot also serve a GCS backend bucket — two LBs, two IPs, two certs. The NEG lets one URL map host both `clockit.setthasit.dev` and `api.clockit.setthasit.dev`, which is what design §7.1 and the cost table assume. Price: the apply-order note above.
- **SPA fallback lives on the URL map**, not the backend bucket: `google_compute_backend_bucket` has no error-policy field in google 7.x. `path_matcher.default_custom_error_response_policy` maps 404 → `/index.html` with response code 200. GA provider, no `google-beta` needed.
- **Atlas PSC is port-mapped**: one address + one forwarding rule (the deprecated legacy architecture needed 50).
- **Two Atlas secrets** (`atlas-public-key`, `atlas-private-key`) instead of one `atlas-api-key` — the provider takes both halves separately.
- **Auth0 domain/audience come from tfvars, not Secret Manager.** The API only verifies JWTs, so it needs no client secret and neither value is sensitive. The `auth0-beta` / `auth0-prod` secret shells still exist for anything that later does need a secret.
- **The Maps key is created, not imported.** A committed `import` block with an unknown key id breaks every plan. To adopt the hand-made console key instead, add this to `10-foundation` before the first apply and delete it after:
  ```hcl
  import {
    to = google_apikeys_key.maps
    id = "projects/<project-number>/locations/global/keys/<key-id>"
  }
  ```
- **Tailscale exposure is layer-7 `Ingress` only, never `tailscale.com/expose`.** The L3 ingress
  Service provisions a proxy needing privileged + `CAP_NET_ADMIN`, and Autopilot's warden rejects it
  (`autogke-disallow-privilege`). Tailscale documents the same limitation for EKS Fargate: Ingress is
  supported on such clusters, ingress Services are not. L7 also terminates TLS with a Let's Encrypt
  cert, which the mobile app needs — iOS ATS and Android's cleartext policy both block plain http.
- **Control-plane authorized networks default to `0.0.0.0/0`** because GitHub-hosted runners have no stable egress range. The endpoint still requires IAM. Narrow `authorized_networks` in `20-cluster` if CI moves to fixed IPs.

## Go-live verification (phase 6 task 10)

Run after the first full apply — none of it can be checked before the cloud exists. Steps 1–4 need
the GCP account that owns `clockit-505408` as your **ADC** (`gcloud auth application-default login`)
and membership in the `hoki-albacore` tailnet; a machine signed into a different tenant or tailnet
fails them with 403s and DNS misses that look like broken infrastructure. Step 5 is public.

1. `tofu plan` clean on every stack (no perma-diff).
2. From a tailnet device: `curl https://clockit-api-beta.<tailnet>.ts.net/healthz` → 200; beta web loads; beta Grafana (`clockit-grafana-beta`) shows traces. Off tailnet: unreachable.
3. Atlas → Network Access has no public entries; `mongosh` works from a pod, fails from a laptop.
4. `gcloud --impersonate-service-account=api-beta@… kms decrypt --key=kek-prod …` → permission denied.
5. `https://clockit.setthasit.dev` loads; `https://clockit.setthasit.dev/table` on refresh → 200; `https://api.clockit.setthasit.dev/healthz` → 200; certs valid.
6. Phase 3 + 5 manual checklists on real devices against beta.
7. Tag `v0.1.0` → prod pipeline green → smoke: sign-in, clock in/out, calendar, tips.
8. After 48 h, billing report ≈ design §7.5 (~$170/mo), no surprise SKUs.
