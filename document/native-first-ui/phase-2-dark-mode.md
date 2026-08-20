# Phase 2: Dark Mode, Brand-Controlled Palette

## Context

Supersedes the rejected "semantic platform colors" phase. Decision (2026-08-19): **no system palettes** — `Color.ios.*` / `Color.android.dynamic.*` are off the table because Material You tints surfaces toward the user's wallpaper and dilutes ClockIt's brand. Every color stays a hand-picked hex under our control; the brand accent `#00286E` is untouchable (AGENTS.md).

Native *feel* still requires following the system appearance. So dark mode ships with a second hand-picked palette of the **same brand hues** — light mode stays pixel-identical to today (the light values are the current theme.ts hexes verbatim).

**Mechanism.** Call sites read `theme.*` inside module-scope `StyleSheet.create`, so scheme-dependent values must resolve natively, not via JS branches:

- **iOS**: `DynamicColorIOS({ light, dark })` from `react-native` — module-scope safe, no config change.
- **Android**: `PlatformColor("@color/<name>")` against day/night resources, written by a small config plugin (native dirs are CNG-generated/gitignored).
- **web**: light hex (mobile web secondary; no dark web this phase).

Both consumers (theme.ts and the config plugin) read one hex table, so the pairs cannot drift.

**Dependencies**: Phase 1 recommended first (deletes two Modal files this phase would otherwise restyle). No other dependency.

## Tasks

- [ ] Task 1: Single-source palette
  - [ ] 1.1: Create `mobile/src/lib/palette.ts` (plain hex pairs)
  - [ ] 1.2: Rebuild `theme.ts` on top of it

- [ ] Task 2: Token split for correctness in dark
  - [ ] 2.1: Add `onBrand`, migrate text-on-brand call sites
  - [ ] 2.2: Add `brandTint`, migrate brand-as-text/tint call sites

- [ ] Task 3: Android day/night color resources
  - [ ] 3.1: Config plugin writing `colors.xml` + `values-night/colors.xml`

- [ ] Task 4: Turn dark mode on
  - [ ] 4.1: `userInterfaceStyle: "automatic"` + splash decision
  - [ ] 4.2: StatusBar audit
  - [ ] 4.3: Sweep stray hardcoded colors

- [ ] Task 5: Verification
  - [ ] 5.1: Typecheck, tests, prebuild check
  - [ ] 5.2: Both schemes on both platforms + AA spot checks

## Implementation Details

### Task 1: Single-source palette

#### 1.1: Create `palette.ts`

**File**: `mobile/src/lib/palette.ts`

Plain data, no React Native imports — the config plugin (Node, config-evaluation time) imports it too:

```ts
/** Hand-picked pairs. Light column IS the shipped light theme — do not "improve" it here. */
export const palette = {
  brand:      { light: "#00286E", dark: "#00286E" }, // fill: brand identity, never tinted
  brandTint:  { light: "#00286E", dark: "#7DA5F5" }, // brand as text/icon on surface
  onBrand:    { light: "#FFFFFF", dark: "#FFFFFF" },
  text:       { light: "#11181C", dark: "#ECEDEE" },
  muted:      { light: "#687076", dark: "#9BA1A6" },
  surface:    { light: "#FFFFFF", dark: "#151718" },
  danger:     { light: "#B3261E", dark: "#F2B8B5" },
  ok:         { light: "#1B7F4B", dark: "#4CBB7F" },
  warn:       { light: "#745B00", dark: "#E0C24A" },
} as const;
```

Dark values are proposals — Task 5 AA checks decide the final hexes (each text color ≥ 4.5:1 on dark `surface`). Light values are the current theme verbatim; changing any of them is out of scope.

#### 1.2: Rebuild `theme.ts`

**File**: `mobile/src/lib/theme.ts`

Keys keep their names (zero call-site churn beyond Task 2's deliberate migrations); values become scheme-aware:

```ts
import { DynamicColorIOS, Platform, PlatformColor } from "react-native";
import { palette } from "./palette";

const dynamic = (name: keyof typeof palette) =>
  Platform.select({
    ios: DynamicColorIOS(palette[name]),
    android: PlatformColor(`@color/clockit_${name.toLowerCase()}`),
    default: palette[name].light,
  })!;

export const theme = {
  brand: palette.brand.light,      // static: same in both schemes
  onBrand: palette.onBrand.light,  // static
  brandTint: dynamic("brandTint"),
  text: dynamic("text"),
  muted: dynamic("muted"),
  surface: dynamic("surface"),
  danger: dynamic("danger"),
  ok: dynamic("ok"),
  warn: dynamic("warn"),
  spacing: { s: 8, m: 16, l: 24 },
  radius: { m: 12, full: 999 },
};
```

Preserve the existing `warn` comment block (AA rationale, web `--color-warning` twin) and extend it with the dark pair.

Type widening: values become `ColorValue` (`string | OpaqueColorValue`). RN style props accept it; run `npx tsc --noEmit` and cast (`as string`, with a comment) only where a third-party prop demands `string` — expected candidates: `SymbolView tintColor`, `NativeTabs tintColor` (the latter gets static `theme.brand`, still a plain string, so likely untouched).

### Task 2: Token split for correctness in dark

#### 2.1: Add `onBrand`, migrate text-on-brand call sites

Several styles use `theme.surface` to mean "white text on brand fill": `ClockButton` label/spinner color (ClockButton.tsx:64,95), the clock card texts (index.tsx:437-439), History's banner label (history.tsx:289), plus brand-filled controls in `sign-in.tsx`/`permissions.tsx`/`profile.tsx`. Once `surface` goes dark, those flip to near-black on an unchanged brand fill — unreadable.

Grep `theme.surface`, classify each use as *background* (keep) vs *on-fill text* (→ `onBrand`).

#### 2.2: Add `brandTint`, migrate brand-as-text/tint call sites

`#00286E` as text on a dark surface is ~2:1 — unreadable. Grep `theme.brand`, classify:

- **tint/text** → `brandTint`: clock screen `actionLabel` (index.tsx:480), History `actionLabel` (history.tsx:307), `SymbolView` tint (permissions.tsx:84), profile links/accents, entry-detail accents. `AppTabs.web.tsx` resolves to the light hex on web either way.
- **fill** → stays `brand`: ClockButton background, clock card, History banner, sign-in/permissions brand blocks, gate styles (splash-matched). White-on-brand is ~12:1 in both schemes; a stable brand fill against a dark background is the point of keeping it.
- `NativeTabs tintColor` (AppTabs.tsx:15): selected-item tint on a native bar → `brandTint` so it stays legible on the dark bar. This is the one place the accent renders differently in dark mode; the hue family is still brand blue.

### Task 3: Android day/night color resources

**File**: `mobile/plugins/withNativeColors.ts` (new), registered in `app.config.ts` `plugins`

```ts
import {
  AndroidConfig,
  type ConfigPlugin,
  withAndroidColors,
  withAndroidColorsNight,
} from "expo/config-plugins";
import { palette } from "../src/lib/palette";

const withNativeColors: ConfigPlugin = (config) => {
  config = withAndroidColors(config, (c) => {
    for (const [name, pair] of Object.entries(palette))
      c.modResults = AndroidConfig.Colors.assignColorValue(c.modResults, {
        name: `clockit_${name.toLowerCase()}`,
        value: pair.light,
      });
    return c;
  });
  return withAndroidColorsNight(config, (c) => {
    for (const [name, pair] of Object.entries(palette))
      c.modResults = AndroidConfig.Colors.assignColorValue(c.modResults, {
        name: `clockit_${name.toLowerCase()}`,
        value: pair.dark,
      });
    return c;
  });
};
export default withNativeColors;
```

`PlatformColor` re-resolves on uiMode changes natively and RN re-renders on appearance change. Spot-check a live theme flip on Android (Task 5): React Compiler memoization + module-scope styles is the combination that can hold stale colors — if a flip leaves stale paint, add a `useColorScheme()` read to the affected screens and comment why.

### Task 4: Turn dark mode on

#### 4.1: Appearance + splash

**File**: `mobile/app.config.ts`

- `userInterfaceStyle: "automatic"`; delete the now-false "single light palette" comment (app.config.ts:15).
- Splash: keep `#00286E` in **both** schemes — brand fill is scheme-stable by decision, and the root gate background (_layout.tsx:274-276) already matches it. No dark splash variant, no gate change; the gate-matches-splash invariant holds with zero work.

#### 4.2: StatusBar audit

Every `StatusBar` was placed per background (documented in `(tabs)/_layout.tsx:5-22`):

- `(tabs)/_layout.tsx`: `style="dark"` → `style="auto"` (`surface` now flips).
- `sign-in.tsx` / `permissions.tsx` / gate: brand-blue backgrounds keep `style="light"` in both schemes.
- Grep `expo-status-bar` usages; re-justify each value in its comment.

#### 4.3: Sweep stray hardcoded colors

Grep `#[0-9A-Fa-f]{3,8}|rgba?\(` under `mobile/src` excluding `palette.ts`/`theme.ts`:

- `history.tsx` skeleton bar `rgba(0,0,0,0.08)` → `rgba(127,127,127,0.16)`-family neutral that reads as a placeholder on both schemes (still not a theme token — its comment's single-caller rationale stands).
- Root gate styles (_layout.tsx:276-299): brand splash handover, scheme-stable by 4.1 — keep.
- Sheet backdrop rgbas are gone with Phase 1.

Everything kept gets kept on purpose; nothing silently.

### Task 5: Verification

#### 5.1: Static

```sh
cd mobile && npx tsc --noEmit && npx expo-doctor && npm test
npx expo prebuild --platform android --no-install   # confirm colors.xml + values-night land, then discard
```

New native config (config plugin) ⇒ new dev builds; Expo Go will not carry the Android color resources.

#### 5.2: Both schemes, both platforms

- Light mode first: must be pixel-identical to pre-phase screenshots (argent `screenshot-diff`) — the palette's light column is the old theme, so any diff is a migration bug.
- Flip appearance mid-session on: Clock (on/off shift), both Phase-1 sheets, History (rows, skeleton, attention block), entry detail (badges, flags), Profile (form, destructive reveal), sign-in, permissions.
- AA checks with final hexes: `brandTint`/`warn`/`ok`/`danger`/`text`/`muted` on dark `surface` ≥ 4.5:1; `onBrand` on `brand` unchanged (~12:1).
- Brand check, the point of this rework: brand blue fills identical in both schemes; nothing wallpaper-tinted on Android 12+.
