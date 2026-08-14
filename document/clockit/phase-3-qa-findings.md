# Phase 3 — QA findings (task 10 verification run)

> **All five fixed and verified 2026-08-14** — see "Resolution" at the end. Two of the fixes
> proposed below turned out to be wrong when tried; the corrections are recorded there rather
> than edited into the findings, so the reasoning that produced them stays readable.

Automated run of `phase-3-mobile-app.md` task 10 against the local stack (`backend/make run` on `:8080`, mongo `clockit_local`, Metro `:8081`). iOS simulator `iPhone 17 Pro` (iOS 26.2) and Android emulator `Pixel_10_Pro` (API 37), both debug dev builds.

Employer anchor for every geo case: seeded Acme Cafe at `49.2827,-123.1207`, `ANCHOR_RADIUS_M=1000`.

## Verification matrix

| # | Check | iOS | Android |
|---|---|---|---|
| 10.1 | Sign-in → lands on Clock | n/a (existing session) | **PASS** (username/password; Google out of scope) |
| 10.2 | Zero membership: no popup, personal entry, out-of-range clock-out | PASS | PASS |
| 10.3 | Member: sheet + distance, in-range in, out-of-range refused | PASS | PASS |
| 10.4 | Mock location → clock-in blocked | n/a (`mocked` is Android-only) | **PASS** |
| 10.5 | Offline clock-in → optimistic → auto-sync | PASS (AppState trigger) | PASS (NetInfo trigger) |
| 10.6 | Assign employer → badge reflects verification | PASS (both branches) | PASS |
| 10.7 | Sign out clears everything; relaunch requires sign-in | unit-covered only | **PASS** |
| 10.8 | `tsc --noEmit`, `expo-doctor`, `npm test` | PASS (0 errors, 20/20, 135/135) | — |

Beyond the checklist, also exercised and passing: 4.2 explainer + "Not now", 6.1 disabled-clock state and its `Turn on location` recovery route, 6.2 live distance polling, 6.3 out-of-range rows tappable with the server as authority, 7.1 chips / "on shift" pulse / sync banner, 7.2 all three badge states, 8.1 name `patchMe` and the unsynced-actions warning, and 4.1's `LocationError` copy (`Could not get a GPS fix…`) when no provider could produce a fix.

10.4's server half is not reachable end-to-end: the local pre-check short-circuits before any request, which is the designed behaviour. The server rule is covered by `backend/internal/entry/geo_test.go:115-141` (including `mocked beats everything` and `queued and mocked`).

---

## Bug 1 — "Last shift" summary is stale until relaunch

**Severity**: medium (wrong information on the primary screen) · **Both platforms** · `mobile/src/lib/clockFlow.ts:342,363`

Clocking out leaves the card showing the *previous* shift. Observed on iOS: closed a shift at 21:37, card read `Last shift 21:33 – 21:33`. Reproduced identically on Android (closed 11:55 PM, card read `11:49 PM – 11:50 PM`). Correct value appears only after the next `hydrateFromServer()`, i.e. app relaunch.

Cause: `await clockOut(body)` discards the closed entry the server returns, and `setOpen(null)` writes `{openEntry: null, pendingSince: null}` without touching `lastClosed`.

This contradicts the 6.1 completion note, which defines `lastClosed` as "the shift most recently *ended*, which is what the screen must show the instant someone clocks out".

**Fix**: capture the response and add a `setClosed(entry)` to `mobile/src/stores/clock.ts` that bumps `writeGen` and sets `{openEntry: null, lastClosed: entry, pendingSince: null}`. The offline path needs no change — the outbox flush already reconciles through `hydrateFromServer()`.

## Bug 2 — Second mobile user ever to sign in is permanently locked out

**Severity**: high (blocks all but the first user) · **Backend** · `backend/internal/user/store.go:175-215`, `internal/auth/jwt.go:27`

`GET /v1/me` returns `409 EMAIL_TAKEN` — *"email already registered to another account"* — and the app parks on its Retry screen with no way forward.

Two independent defects compound:

1. **No email ever reaches the backend.** `Claims.Email` reads the namespaced claim `https://clockit/email`, which only an Auth0 Action can add. Auth0 **access** tokens for a custom API audience carry no `email` by default and no such Action is configured, so every user is inserted with `email: ""`. Confirmed on both platforms and — critically — for a *database-connection* signup with a real address, so this is not Google-specific.
2. **The uniqueness index is not partial.** `db.users` carries `email_1` as a plain `unique: true` index. The first `email: ""` document therefore claims the value, and every subsequent insert hits E11000 → `findOne(sub)` misses → `ErrEmailTaken`.

Encountered twice during this run; each time it had to be cleared by hand before testing could continue.

Knock-on effect: `claimInvitations` matches on `{email, user_id: nil, status: "invited"}`, so with an empty email **email-based invitations can never bind to a user**. Memberships had to be attached by `user_id` directly to test 10.3/10.6.

**Fix** (both parts required):
- Add the Auth0 Action that sets `https://clockit/email` and `https://clockit/email_verified` on the access token.
- Make the index partial so `""` cannot collide, e.g. `{email: 1}` unique with `partialFilterExpression: {email: {$type: "string", $ne: ""}}`.

## Bug 3 — Android status bar content invisible on light screens

**Severity**: medium (visual) · **Android only** · no `StatusBar` configuration exists in `mobile/`

Clock, History, Profile and entry-detail all render with the system status bar blank — no clock, battery or signal. Only the brand-blue sign-in screen shows them (white on blue).

Cause: nothing in the app sets the status bar content style — `rg "expo-status-bar|StatusBar" mobile/src mobile/app.config.ts` returns nothing — so Android's edge-to-edge default leaves light (white) icons over the app's light backgrounds. iOS is unaffected because `userInterfaceStyle: "light"` (`app.config.ts:11`) already yields dark status bar content there.

**Fix**: render `<StatusBar style="dark" />` from `expo-status-bar` in `mobile/src/app/_layout.tsx`, overriding to `light` on the brand-blue sign-in screen.

## Bug 4 — `formatDistance` keeps one decimal at any magnitude

**Severity**: low (cosmetic) · **Both platforms** · `mobile/src/lib/format.ts:19`

The employer sheet renders `7548.3 km, out of range`, and the same string reaches the refusal copy: *"You're 7548.3 km from Harbour Bistro — move within 1.0 km."* A tenth of a kilometre is noise at that scale.

`return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;` — `toFixed(1)` is unconditional. The plan only specifies `620 m` / `2.4 km`, both of which stay correct under any fix.

**Fix**: drop the decimal above some threshold, e.g. `m >= 100_000 ? Math.round(m / 1000)` before falling back to `toFixed(1)`.

## Bug 5 — Profile shows a bare `EMAIL` heading with no value

**Severity**: low (cosmetic; a visible symptom of bug 2) · **Both platforms** · `mobile/src/app/(tabs)/profile.tsx:212`

`<Text style={styles.fieldValue}>{me.user.email}</Text>` renders an empty string, leaving a labelled field with nothing under it.

**Fix**: fall back to a placeholder, or hide the row when the email is empty. Resolving bug 2 removes the common case but not the empty-value path.

---

## Resolution (2026-08-14)

Every bug reproduced from source before being fixed, and each fix was re-checked on the Android
emulator (`Pixel_10_Pro`) and the iOS simulator (`iPhone 17 Pro`) against the same local stack.

| # | Verdict | Landed in |
|---|---|---|
| 1 | Confirmed | `stores/clock.ts` gained `setClosed`; `clockFlow.ts` keeps the entry `clockOut` returns |
| 2 | Confirmed — **backend half only**; the Auth0 Action stays a tenant prerequisite | `mongox/indexes.go` partial index, `user/store.go` empty-email guard |
| 3 | Confirmed; the proposed fix does not work (below) | one `StatusBar` per background region, 5 files |
| 4 | Confirmed | `lib/format.ts` |
| 5 | Confirmed | `(tabs)/profile.tsx` — row hidden, not placeholdered |

Both `clockOutNow` and `GetOrCreate` fixes are pinned by tests that were mutation-checked: reverting
the source line fails them (`an accepted clock-out clears the shift and becomes the last shift`,
`TestGetOrCreateAdmitsSeveralUsersWithoutAnEmail`).

**Bug 2 — the proposed `partialFilterExpression` is rejected by MongoDB.** `$ne` is not in the
accepted operator set (equality/`$eq`, `$exists: true`, `$gt/$gte/$lt/$lte`, `$type`, `$and/$or/$in`,
`$geoWithin/$geoIntersects`), so `{email: {$type: "string", $ne: ""}}` fails at creation with
`CannotCreateIndex … Expression not supported in partial index: $not` — confirmed against the
compose Mongo 8. Shipped as `{email: {$gt: ""}}`. Also unmentioned in the finding: `EnsureIndexes`
is idempotent only for *identical* specs, so an existing database fails startup with
`IndexKeySpecsConflict` until `db.users.dropIndex("email_1")` runs once. No migration code — nothing
is deployed.

**Bug 3 — the proposed fix inverts on the screen it was meant to protect.** A root
`<StatusBar style="dark" />` with a `light` override on sign-in gives the *blue* screen dark icons:
RN's `StatusBar` applies the last-*mounted* entry of a props stack (`StatusBar.js:404-410`) and
`componentDidMount` runs child-first, so the root instance is pushed after every screen's and wins.
A build-time-only fix (the `expo-status-bar` config plugin, which writes `android:windowLightStatusBar`)
fails differently — on unmount RN falls back to `_defaultProps.barStyle = 'default'`, which
`WindowUtil.kt` maps to *clearing* `APPEARANCE_LIGHT_STATUS_BARS`, i.e. white icons again. What
shipped is one `StatusBar` per background colour and none at the root: `dark` on `(tabs)/_layout.tsx`
(inherited by `entry/[id]` and a pushed `permissions`, both verified) and `permissions.tsx` (the gate
renders it before any navigator exists); `light` on `sign-in.tsx` and the two brand-blue gate screens
in `_layout.tsx`. The theme file confirmed the cause: generated `AppTheme` sets `statusBarColor`
transparent and no `windowLightStatusBar`, which defaults to false.

**Not executed**: the sign-in screen's own status bar, because the tenant password for
`android-tester@clockit.test` was not available and signing out is one-way here. The blue gate
spinner — same colour, same `style="light"`, same "no tabs StatusBar mounted" state — was verified
instead. On Android the transition cannot regress in any case: `light` and the `default` fallback
both resolve to white icons there. On iOS `default` means dark content, so sign-in was *already*
dark-on-#00286E before this change; the added `light` can only improve it.

## Environment note (not an app bug)

The Android emulator could not resolve **any** hostname while raw IPs worked, so Auth0 was unreachable and sign-in failed with `DNS_PROBE_STARTED`. Cause: stale QEMU DNS captured when the AVD booted ~32 h earlier. `private_dns_mode` changes did not help; killing and re-booting the AVD did. Worth checking first if Universal Login fails to load on Android.

## Test artifacts left behind

- **Auth0 tenant**: new database-connection user `android-tester@clockit.test` (password held by the operator, unverified email), created because no credentials were available and Google sign-in was out of scope. Delete it or keep it as the Android test account.
- **Mongo `clockit_local`**: two test users (`auth0|6a7e969b…` iOS, `auth0|6a7eba23…` Android) with 2 memberships each and 7 entries between them; the pre-existing web-owner document's email was changed from `""` to `web-owner@clockit.test`, and the iOS test user's to `ios-tester@clockit.test`, to work around bug 2.
- **Android emulator**: mock location providers removed, `mock_location` appops reset to default, `private_dns_mode` deleted, airplane mode off.
