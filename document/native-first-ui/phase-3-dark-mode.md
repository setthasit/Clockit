# Phase 3: Dark Mode

## Context

Native look and feel includes following the system appearance. Today `app.config.ts` pins `userInterfaceStyle: "light"` because theme.ts was a single light palette (its own comment says so). After Phase 2, `text`/`muted`/`surface`/`danger` (+ iOS `ok`) adapt for free; what remains is the brand colors that render as *text or tint on `surface`*, the status bars, and the splash handover.

**Brand-color mechanism.** Call sites read `theme.*` at module scope (Phase 2 constraint), so scheme-dependent brand variants must be natively-resolving values, not JS branches:

- **iOS**: `DynamicColorIOS({ light, dark })` — works at module scope, no config change.
- **Android**: `PlatformColor("@color/<name>")` against day/night resources. The native dirs are CNG-generated (gitignored), so the resources are added by a small config plugin that writes `values/colors.xml` and `values-night/colors.xml`.
- **web**: keeps the light hex (mobile web is secondary; dark web support would be a CSS variable exercise for another day).

**Colors that need a dark variant** (each fails contrast as text on a dark surface):

| token | light | dark (proposed — confirm against AA before committing) |
|---|---|---|
| `brand` as text/tint | `#00286E` (~10.6:1 on white) | `#8AB4F8`-family blue, ≥4.5:1 on `systemBackground` dark |
| `warn` | `#745B00` | `#E0C24A`-family amber, ≥4.5:1 |
| `ok` (Android) | `#1B7F4B` | `#4CBB7F`-family green, ≥4.5:1 |

`brand` as *fill* (ClockButton, clock card, banner) keeps `#00286E` in both schemes — `onBrand` white text on it is ~12:1 regardless, and a stable brand fill against a dark background reads fine. This forces the token split below.

**Dependencies**: Phase 2 complete (semantic tokens + `onBrand` in place).

## Tasks

- [ ] Task 1: Split brand into fill vs tint tokens
  - [ ] 1.1: Add `brandTint`, keep `brand` for fills
  - [ ] 1.2: Migrate text/tint call sites

- [ ] Task 2: Android day/night color resources
  - [ ] 2.1: Config plugin writing colors.xml pairs
  - [ ] 2.2: Wire `PlatformColor` values into theme.ts

- [ ] Task 3: iOS dynamic colors
  - [ ] 3.1: `DynamicColorIOS` pairs for brandTint/warn/ok

- [ ] Task 4: Turn dark mode on
  - [ ] 4.1: `userInterfaceStyle: "automatic"` + splash dark variant
  - [ ] 4.2: StatusBar audit

- [ ] Task 5: Verification
  - [ ] 5.1: Typecheck, tests, prebuild check
  - [ ] 5.2: Both schemes on both platforms + AA spot checks

## Implementation Details

### Task 1: Split brand into fill vs tint tokens

#### 1.1: Add `brandTint`

**File**: `mobile/src/lib/theme.ts`

`brand` (static hex) stays for fills: ClockButton background, clock card, History banner, sign-in/permissions brand blocks, splash-matched gate styles. New `brandTint` is the scheme-aware one for text, icons, and tint.

#### 1.2: Migrate call sites

Grep `theme.brand` and classify:

- **tint/text** → `brandTint`: clock screen `actionLabel` (index.tsx:480), History `actionLabel` (history.tsx:307), `NativeTabs tintColor` (AppTabs.tsx:15), `SymbolView tintColor` (permissions.tsx:84), profile links/accents, entry-detail accents, web tab tint (AppTabs.web.tsx — resolves to the light hex there).
- **fill** → stays `brand`.

The clock card and ClockButton sit on `surface` in both schemes with `onBrand` labels — verified visually in 5.2, no code change.

### Task 2: Android day/night color resources

#### 2.1: Config plugin

**File**: `mobile/plugins/withNativeColors.ts` (new), registered in `app.config.ts` `plugins`

Use `@expo/config-plugins` `withAndroidColors` / `withAndroidColorsNight` (both exported from `expo/config-plugins` in SDK 57):

```ts
import { type ConfigPlugin, AndroidConfig, withAndroidColors, withAndroidColorsNight } from "expo/config-plugins";

const LIGHT = { clockit_brand_tint: "#00286E", clockit_warn: "#745B00", clockit_ok: "#1B7F4B" };
const DARK = { clockit_brand_tint: "#8AB4F8", clockit_warn: "#E0C24A", clockit_ok: "#4CBB7F" };

const withNativeColors: ConfigPlugin = (config) => {
  config = withAndroidColors(config, (c) => {
    for (const [name, value] of Object.entries(LIGHT))
      c.modResults = AndroidConfig.Colors.assignColorValue(c.modResults, { name, value });
    return c;
  });
  return withAndroidColorsNight(config, (c) => {
    for (const [name, value] of Object.entries(DARK))
      c.modResults = AndroidConfig.Colors.assignColorValue(c.modResults, { name, value });
    return c;
  });
};
export default withNativeColors;
```

Final hex values come from Task 5's AA checks, not from this sketch.

#### 2.2: Wire into theme.ts

```ts
warn: Platform.select({
  ios: DynamicColorIOS({ light: "#745B00", dark: "#E0C24A" }),
  android: PlatformColor("@color/clockit_warn"),
  default: "#745B00",
})!,
```

`PlatformColor` re-resolves on uiMode changes natively; RN re-renders on appearance change. Spot-check a live theme flip on Android (Task 5) since React Compiler memoization plus module-scope styles is exactly the combination the expo-native-ui guidance warns needs a `useColorScheme()` subscription — if a flipped scheme leaves stale colors on screen, add `useColorScheme()` reads to the affected screens and note why.

### Task 3: iOS dynamic colors

**File**: `mobile/src/lib/theme.ts`

`DynamicColorIOS` pairs for `brandTint`, `warn` (and `ok` stays `Color.ios.systemGreen`, which already adapts). Import from `react-native`. Module-scope safe.

### Task 4: Turn dark mode on

#### 4.1: Appearance + splash

**File**: `mobile/app.config.ts`

- `userInterfaceStyle: "automatic"` (delete the now-false "single light palette" comment).
- `expo-splash-screen` plugin: add `dark: { backgroundColor: "#001536" }` (darkened brand) — and update the root gate's brand background (_layout.tsx:274-276 comment contract: gate must match splash) to the same pair via `DynamicColorIOS` / `@color` resource, or keep both static `#00286E` and skip the dark splash entirely. Decide once, keep the gate-matches-splash invariant either way.

#### 4.2: StatusBar audit

Every `StatusBar` was placed per background (documented in `(tabs)/_layout.tsx:5-22`):

- `(tabs)/_layout.tsx`: `style="dark"` → `style="auto"` (surface now flips).
- `sign-in.tsx` / `permissions.tsx` / gate screens: brand-blue backgrounds keep `style="light"` in both schemes.
- Grep `expo-status-bar` usages and re-justify each one's value in its comment.

### Task 5: Verification

#### 5.1: Static

```sh
cd mobile && npx tsc --noEmit && npx expo-doctor && npm test
npx expo prebuild --platform android --no-install   # confirm colors.xml + values-night land, then discard
```

New native config (config plugin) ⇒ new dev builds required; Expo Go will not carry the Android color resources.

#### 5.2: Both schemes, both platforms

- Flip appearance mid-session (Android quick toggle, iOS Settings) on: Clock (on/off shift), both sheets, History (rows, skeleton, attention block), entry detail (badges, flags), Profile (form, destructive reveal), sign-in, permissions.
- AA spot checks with the final hexes: `brandTint`/`warn`/`ok` on dark `surface` ≥ 4.5:1; `onBrand` on `brand` unchanged.
- Splash → gate handover in dark mode shows no color flash (the invariant the gate comment promises).
