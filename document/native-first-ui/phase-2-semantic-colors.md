# Phase 2: Semantic Platform Colors

## Context

`mobile/src/lib/theme.ts` is a single static hex palette. Native-first look means the app should draw from the platform's own semantic colors — iOS UIKit colors (`label`, `systemBackground`, …) and Material 3 dynamic colors on Android (adapt to the user's wallpaper on 12+) — via the type-safe `Color` API from `expo-router`, wrapped in `Platform.select` with the current hex values as web defaults.

**Key design constraint:** every consumer reads `theme.*` inside module-scope `StyleSheet.create`. `PlatformColor`-backed values (`Color.ios.*`, `Color.android.*`) are opaque handles resolved natively at render time, so they are safe at module scope; a JS-branched light/dark lookup would not be. Nothing about this phase changes call sites — only the values behind the existing keys change, plus one new key.

**Scope guard:** `userInterfaceStyle` stays `"light"` in this phase. Semantic colors resolve to their light variants, so screens look near-identical; this phase is the mechanical substitution, phase 3 turns dark mode on. Brand colors stay brand: `#00286E` is product identity (AGENTS.md), not a system color.

**Dependencies**: none strictly; land after Phase 1 to avoid restyling files Phase 1 deletes.

## Tasks

- [ ] Task 1: Semantic palette in theme.ts
  - [ ] 1.1: Substitute values behind existing keys
  - [ ] 1.2: Add `onBrand` token and migrate text-on-brand call sites

- [ ] Task 2: Absorb type widening
  - [ ] 2.1: Fix `ColorValue` mismatches at consumers

- [ ] Task 3: Sweep stray hardcoded colors
  - [ ] 3.1: Map or deliberately keep each non-theme color literal

- [ ] Task 4: Verification
  - [ ] 4.1: Typecheck + tests
  - [ ] 4.2: Visual parity pass

## Implementation Details

### Task 1: Semantic palette in theme.ts

#### 1.1: Substitute values

**File**: `mobile/src/lib/theme.ts`

| key | iOS | Android | web default (current hex) |
|---|---|---|---|
| `brand` | keep `#00286E` | keep `#00286E` | `#00286E` |
| `text` | `Color.ios.label` | `Color.android.dynamic.onSurface` | `#11181C` |
| `muted` | `Color.ios.secondaryLabel` | `Color.android.dynamic.onSurfaceVariant` | `#687076` |
| `surface` | `Color.ios.systemBackground` | `Color.android.dynamic.surface` | `#FFFFFF` |
| `danger` | `Color.ios.systemRed` | `Color.android.dynamic.error` | `#B3261E` |
| `ok` | `Color.ios.systemGreen` | keep `#1B7F4B` (Material has no success role) | `#1B7F4B` |
| `warn` | keep `#745B00` | keep `#745B00` | `#745B00` |

```ts
import { Platform } from "react-native";
import { Color } from "expo-router";

export const theme = {
  brand: "#00286E",
  text: Platform.select({
    ios: Color.ios.label,
    android: Color.android.dynamic.onSurface,
    default: "#11181C",
  })!,
  // …
  spacing: { s: 8, m: 16, l: 24 },
  radius: { m: 12, full: 999 },
};
```

Notes to encode as comments:
- `warn` stays hex: it was picked for AA on `surface` (~6.4:1, theme.ts:8-12) and matches the web app's `--color-warning`; no system yellow/orange passes AA as text on white. Its dark variant is Phase 3's problem.
- `ok` on Android stays hex for the same reason — the Material scheme has no "success" color; a green from another palette would be a second convention.
- `Color.android.dynamic.*` falls back to the static Material baseline below Android 12 — verify once on an API-31-or-lower emulator and note the observed fallback.

#### 1.2: Add `onBrand`, migrate text-on-brand call sites

**File**: `mobile/src/lib/theme.ts` + consumers

Several styles use `theme.surface` to mean "white text on brand fill": `ClockButton` label/spinner (ClockButton.tsx:64,95), the clock card texts (index.tsx:437-439), History's banner label (history.tsx:289), and any brand-filled control in `profile.tsx`/`sign-in.tsx`/`permissions.tsx` (grep `theme.surface` and classify each use as background vs on-fill text). Once `surface` is semantic, those would flip to near-black in dark mode against an unchanged brand fill.

Add `onBrand: "#FFFFFF"` (static — the fill it sits on is static) and switch every on-fill usage to it. This is a correctness prerequisite for Phase 3, done now while every `theme.surface` reference is being eyeballed anyway.

### Task 2: Absorb type widening

#### 2.1: Fix `ColorValue` mismatches

Theme values widen from `string` to `ColorValue` (`string | OpaqueColorValue`). RN style props accept `ColorValue`; third-party props may not:

- `SymbolView` `tintColor` (permissions.tsx:84, AppTabs.web.tsx) — web file keeps plain hex anyway via `Platform.select` default; on native cast `as string` only if the prop type demands it, with a comment.
- `NativeTabs tintColor={theme.brand}` — stays a plain hex string, unaffected.
- `expo-status-bar` and `ActivityIndicator color` accept `ColorValue` — no change expected.

Let `npx tsc --noEmit` enumerate the real list; fix only what it names.

### Task 3: Sweep stray hardcoded colors

#### 3.1: Classify literals

Grep `#[0-9A-Fa-f]{3,8}|rgba?\(` under `mobile/src`, excluding theme.ts. Expected survivors and their treatment:

- `history.tsx` skeleton `rgba` bar — replace with `Color.ios.tertiarySystemFill` / `Color.android.dynamic.surfaceVariant` (it stops being invisible in dark mode later); its "not a theme token" comment stays true.
- Root gate styles `_layout.tsx:276-299` — brand splash handover; keep (splash background is compile-time).
- Any backdrop rgba dies with Phase 1's Modal deletion.

Everything kept gets kept on purpose; nothing silently.

### Task 4: Verification

#### 4.1: Static + unit

```sh
cd mobile && npx tsc --noEmit && npx expo-doctor && npm test
```

#### 4.2: Visual parity pass

Light mode, iOS + Android dev builds: Clock, History (loaded + skeleton), Profile, entry detail, sign-in, permissions, both Phase-1 sheets. Expect near-identical rendering (system light values ≈ old hexes); Android on 12+ shows dynamic-tinted surfaces — that is the feature, not a regression. Screenshot before/after per screen (argent `screenshot` + `screenshot-diff`) and eyeball every diff.
