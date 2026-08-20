# Phase 3: Native Feel Polish

## Context

Independent, individually shippable refinements that close the remaining look-and-feel gaps. Each task is optional on its own; none blocks the others. Ordered by value.

Palette rule from Phase 2 applies here too: **no system color APIs** — any new color is a hand-picked pair in `palette.ts`.

**Dependencies**: Phase 1 (sheets) for task ordering only; tasks 1–4 do not depend on Phase 2. Task 5 wants Phase 2's palette mechanism for its grouped-background tokens.

## Tasks

- [ ] Task 1: Large-title scroll behavior on iOS
  - [ ] 1.1: `contentInsetAdjustmentBehavior="automatic"` on History + entry detail + Profile scrollers

- [ ] Task 2: Haptics on clock in/out
  - [ ] 2.1: Add `expo-haptics`, fire on success

- [ ] Task 3: Context menu + preview on history rows
  - [ ] 3.1: Wrap synced `EntryRow`s in `Link` with `Link.Preview`

- [ ] Task 4: Predictive back on Android
  - [ ] 4.1: Enable and regression-test back flows

- [ ] Task 5: Profile as grouped list
  - [ ] 5.1: Restyle to inset-grouped sections

- [ ] Task 6: Verification
  - [ ] 6.1: Typecheck + tests + on-device pass

## Implementation Details

### Task 1: Large-title scroll behavior

**Files**: `mobile/src/app/(tabs)/(history)/history.tsx`, `mobile/src/app/entry/[id].tsx`, `mobile/src/app/(tabs)/(profile)/profile.tsx`

No scroller in the app sets `contentInsetAdjustmentBehavior` today (grep confirms). With opaque headers it is currently harmless, but the native iOS pattern — large title that collapses into the bar as the list scrolls, content scrolling under a translucent bar — needs it. Add `contentInsetAdjustmentBehavior="automatic"` to History's `SectionList`, entry detail's `ScrollView`, and Profile's `ScrollView`, then remove any padding that double-counts. Verify the History large title collapses/expands correctly and `RefreshControl` still sits below the header. Android ignores the prop.

### Task 2: Haptics on clock in/out

**Files**: `mobile/package.json`, `mobile/src/lib/clockFlow.ts` callers (clock screen `run`, clock-in sheet `select`)

```sh
npx expo install expo-haptics
```

On a successful clock action (`done === true`) fire `Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)` guarded by `process.env.EXPO_OS === "ios"` (Android system haptics for taps already exist; doubling them reads as buzzy). Never on failure paths — the live-region error is the feedback there. Works in Expo Go and dev builds; a no-op on web.

### Task 3: Context menu + preview on history rows

**Files**: `mobile/src/app/(tabs)/(history)/history.tsx` (row `renderItem`), `mobile/src/components/EntryRow.tsx`

For rows that navigate (synced entries with a server id — the screen already withholds `onPress` from unsynced ones), wrap in `Link` per iOS convention:

```tsx
<Link href={`/entry/${entry.id}`} asChild>
  <Link.Trigger>
    <EntryRow … />
  </Link.Trigger>
  <Link.Preview />
</Link>
```

Costs to check before committing: the preview mounts `/entry/[id]`, which fetches the 30-day window on mount — acceptable (same fetch the tap would do), but confirm the peek does not fire duplicate fetches. Keep the row's composed `accessibilityLabel` untouched; unsynced rows stay plain `Pressable`s. Skip a `Link.Menu` — there is no secondary action on a shift today, and inventing one ("copy times"?) is scope creep.

### Task 4: Predictive back on Android

**File**: `mobile/app.config.ts`

`predictiveBackGestureEnabled: true`. Then regression-test every back interaction on Android 14+: sheet dismissal (Phase 1 routes), entry detail pop, permissions pop, sign-in (no back target), and the profile destructive-reveal (its confirm is a reveal, not a dialog, so back must simply pop the screen). If any RN back-handler misbehaves under the predictive animation, revert and record why in a comment on the flag — this flag is the one task here with real regression surface.

### Task 5: Profile as grouped list

**File**: `mobile/src/app/(tabs)/(profile)/profile.tsx` (+ `mobile/src/lib/palette.ts`)

Keep plain RN (the `@expo/ui` a11y objections at profile.tsx:44-55 still hold — do not revisit). Restyle to read as a native settings screen, colors hand-picked (mirroring the iOS grouped idiom without touching system palettes):

- New palette pairs: `groupedSurface` `{ light: "#F2F2F7", dark: "#000000" }` (screen background) and `card` `{ light: "#FFFFFF", dark: "#1C1C1E" }` (section background) — proposals, finalized against the Phase 2 AA pass.
- Sections (Account / Employers / App) as inset cards: `card` background, radius `theme.radius.m`, `borderCurve: "continuous"`, hairline separators (`StyleSheet.hairlineWidth`, `muted` at reduced opacity or a dedicated `separator` pair if that reads muddy).
- Sign out stays a full-width red row inside the last group (HIG destructive-row idiom) with the existing reveal-confirm flow untouched.
- All existing a11y labels, busy announcements, and the unsynced-actions warning keep their exact semantics — this task moves pixels only.

### Task 6: Verification

```sh
cd mobile && npx tsc --noEmit && npx expo-doctor && npm test
```

- iOS: large title collapse (History), peek/pop preview on a synced row, success haptic on clock-in, Profile reads as grouped list with VoiceOver order unchanged.
- Android: predictive back animation across all pop targets; no haptic doubling.
