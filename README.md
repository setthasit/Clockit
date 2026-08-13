# ClockIt

> **Status: Work in progress** — currently in the design phase. No application code yet; the system design is under review.
>
> This repository is the MVP/reference implementation; it is not the production product.
>
> Built with AI (design, code, and infrastructure developed with AI assistance).

Employee clock-in/clock-out with location validation. Employees clock in from a mobile app (with anti-mock-location checks and 1 km proximity validation against their employer's location); employers manage employees, view shifts on a calendar or table, and split daily tips by hours worked.

![Architecture](docs/diagrams/architecture.svg)

## Documentation

- [System design](docs/design.md)
- Diagrams: [architecture](docs/diagrams/architecture.svg) · [infrastructure](docs/diagrams/infra.svg) · [clock-in flow](docs/diagrams/clock-in-flow.svg)

## Stack

| Part | Tech |
|---|---|
| `mobile/` — employee app | React Native, Expo, Zustand, Expo UI, Auth0 |
| `web/` — employer app | React 19, Astryx (StyleX), Vite, Auth0 |
| `backend/` — API | Go, Echo, uber/fx, MongoDB, Valkey, KEK/DEK envelope encryption (Cloud KMS), OpenTelemetry (traces + metrics + logs) |
| `infra/` | GCP (GKE Autopilot, Cloud CDN, Cloud KMS), MongoDB Atlas (private endpoint), Cloudflare DNS, Tailscale (beta env), OpenTofu |

Development is local-first (docker-compose: MongoDB, Valkey, `grafana/otel-lgtm`); cloud infra is provisioned last, right before publishing.

## Roadmap

- [x] System design
- [ ] Foundations (compose stack, backend skeleton, Auth0 tenant, seed script)
- [ ] Backend MVP (auth, envelope crypto, clock-in/out + proximity, employers/members, OTel)
- [ ] Mobile MVP (auth, clock screen, history, offline outbox)
- [ ] Web MVP (onboarding, employees, calendar, table + tips)
- [ ] Background pings + reports
- [ ] Infra (OpenTofu stacks, CI/CD, beta on tailnet)
- [ ] Publish (prod deploy, store submissions)
- [ ] Hardening (Play Integrity / App Attest, alerting, backup drill)

## License

[MIT](LICENSE)
