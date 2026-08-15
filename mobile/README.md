# ClockIt mobile

Expo (SDK 57) app. Local dev talks to the backend on your LAN; beta and production builds are made with EAS.

## Local development

```sh
cp .env.example .env      # set EXPO_PUBLIC_API_URL to the LAN IP of `cd backend && make run`
npm install
npm start
```

`.env` is gitignored and `EXPO_PUBLIC_*` values are inlined into the JS bundle — never put a secret there.

## EAS profiles (`eas.json`)

| Profile | Distribution | Channel | API |
|---|---|---|---|
| `development` | internal, dev client | — | whatever `.env` says |
| `beta` | internal | `beta` | `https://clockit-api-beta.<tailnet>.ts.net` |
| `production` | store | `production` | `https://api.clockit.duckos.ai` |

```sh
eas init                                  # one-time: creates the EAS project
eas build --profile beta --platform ios   # or android
eas update --channel beta                 # OTA JS-only update
eas submit --profile production --platform ios
```

No CI automation for mobile in v1 — these are run by hand.

## Beta testers must join the tailnet

The beta API and beta web are Tailscale devices with no public IP (design §7.3). A beta build cannot reach the API from the open internet. Every beta tester has to:

1. Install the Tailscale app.
2. Sign in to the ClockIt tailnet (invite from the tailnet admin).
3. Keep Tailscale connected while using the beta build.

Production builds need none of this.

## Values a human must fill before the first build

- `eas.json` → every `REPLACE-ME-*`: the tailnet name in the beta API URL, and the Auth0 beta/prod tenant domain + native client id. `EXPO_PUBLIC_AUTH0_AUDIENCE` is already correct.
- `eas.json` → `submit.production.ios`: Apple ID, App Store Connect app id, Apple team id.
- `app.config.ts` → after `eas init` + `eas update:configure`, add `extra.eas.projectId` and `updates.url` (the EAS CLI cannot write a TypeScript config, so this edit is manual).

Changing `EXPO_PUBLIC_AUTH0_DOMAIN` requires a new native build — the `react-native-auth0` config plugin bakes it into the native project.
