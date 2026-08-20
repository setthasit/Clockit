# Phase 1: Native Sheets (formSheet routes)

## Context

ClockIt mobile is already native-first in navigation chrome: `NativeTabs` (UITabBar / Material 3 bottom nav) via `AppTabs.tsx`, a native `Stack` per tab, `headerLargeTitle` on History/Profile, native `Alert.alert` for the GPS-weak confirm, SF Symbols via `expo-symbols`.

The two remaining non-native surfaces the user feels most are the bottom sheets:

- `mobile/src/components/EmployerSheet.tsx` — "Clock in for" chooser. Plain RN `Modal` + hand-built card, backdrop `Pressable`, manual `accessibilityViewIsModal`, manual safe-area inset.
- `mobile/src/components/BackgroundSheet.tsx` — Always-location pitch. Same construction.

Both were built as `Modal` because `@expo/ui`'s `BottomSheet` cannot label rows for TalkBack (documented in EmployerSheet.tsx:44-53). That objection does not apply to **route-based `presentation: "formSheet"`**: the sheet is a real `UISheetPresentationController` on iOS (detents, grabber, dim, swipe-dismiss, liquid glass on iOS 26 with transparent `contentStyle`) and Material `BottomSheetBehavior` on Android (verified against react-native-screens 4.26 docs), while the children stay plain RN views with full a11y props. No new dependency: `react-native-screens` ~4.26 and `expo-router` ~57 are installed.

**Consequences of moving from controlled component to route:**

1. The sheet no longer receives `fix`/`busy`/`error` props from the clock screen. It owns them. The clock screen's fix poller tears down anyway when the sheet route takes focus (`useFocusEffect`), so the sheet must poll for itself — extract the poller into a shared hook.
2. `run()`'s employer-clock-in path moves into the sheet route. The clock screen keeps `run()` for clock-out and personal clock-in only.
3. The background sheet's "declined" notice must outlive the route. It moves to a transient (non-persisted) field on `useUiStore`.
4. **Web**: expo-router renders a formSheet route as a plain page (no sheet on web). Accepted: the mobile-web target is secondary, and a full-page "Clock in for" chooser is functional. This removes the need for a `.web.tsx` split.

**Non-goals:** no change to `clockFlow.ts` semantics, no change to when the background pitch appears (`askBackground` condition stays byte-identical), no redesign of sheet content copy.

**Dependencies**: none. Independent of phases 2–3.

## Tasks

- [x] Task 1: Extract shared fix poller hook
  - [x] 1.1: Create `useFixPoll` in `mobile/src/location/useFixPoll.ts`
  - [x] 1.2: Rewire clock screen to use it

- [x] Task 2: Transient tracking notice in ui store
  - [x] 2.1: Add `trackingNotice` to `useUiStore`
  - [x] 2.2: Pin non-persistence in `ui.test.js`

- [ ] Task 3: Clock-in sheet route
  - [ ] 3.1: Create `mobile/src/app/clock-in.tsx`
  - [ ] 3.2: Register in root stack with formSheet options

- [ ] Task 4: Background-location sheet route
  - [ ] 4.1: Create `mobile/src/app/background-location.tsx`
  - [ ] 4.2: Register in root stack with formSheet options

- [ ] Task 5: Rewire clock screen
  - [ ] 5.1: Replace `sheetOpen` state with `router.push`
  - [ ] 5.2: Replace conditional `BackgroundSheet` mount with focus-guarded push
  - [ ] 5.3: Render `trackingNotice` from the store

- [ ] Task 6: Delete Modal sheets
  - [ ] 6.1: Remove `EmployerSheet.tsx` and `BackgroundSheet.tsx`

- [ ] Task 7: Verification
  - [ ] 7.1: Typecheck + unit tests
  - [ ] 7.2: On-device sheet behavior (iOS + Android)

## Implementation Details

### Task 1: Extract shared fix poller hook

**Goals:**
- One implementation of the self-chaining, overlap-free 15 s poll (clock screen index.tsx:235-276) usable by both the clock screen and the clock-in sheet.

#### 1.1: Create `useFixPoll`

**File**: `mobile/src/location/useFixPoll.ts`

Lift the body of the clock screen's polling `useFocusEffect` verbatim (self-chaining timeout, `cancelled` flag, immediate first read, `setFix(null)` on teardown, swallow-and-null on error). Signature:

```ts
export function useFixPoll(active: boolean): Fix | null;
```

Internally: `useFocusEffect(useCallback(..., [active]))` exactly as today, `FIX_POLL_MS = 15_000` moves here. Keep the existing comments — the overlap/teardown caveats (index.tsx:235-245) still hold and the "tasks 6.3/6.4 must not inherit the stronger reading" warning now applies to the sheet.

#### 1.2: Rewire clock screen

**File**: `mobile/src/app/(tabs)/(clock)/index.tsx`

Replace the `fix` state + polling effect with `const fix = useFixPoll(polling)`. `polling` stays `showDistance && foreground`. No behavior change; `DistanceBadge` keeps its prop.

### Task 2: Transient tracking notice in ui store

**Goals:**
- The background sheet route can report "declined" to the clock screen after it has unmounted.

#### 2.1: Add `trackingNotice`

**File**: `mobile/src/stores/ui.ts`

```ts
trackingNotice: string | null;          // transient, like `hydrated`
setTrackingNotice(notice: string | null): void;
```

Default `null`, **excluded from `partialize`** (same treatment as `hydrated` — a relaunch must not resurrect a stale notice). Move the `BACKGROUND_DECLINED` copy from the clock screen next to the route that sets it (Task 4).

#### 2.2: Pin non-persistence

**File**: `mobile/src/stores/ui.test.js`

Extend the existing partialize/rehydrate tests: setting `trackingNotice` then rehydrating yields `null`. This is the observable contract that keeps the notice transient.

### Task 3: Clock-in sheet route

**Goals:**
- Native sheet chrome; identical selection semantics: stays open on refusal (error inline), closes only when the write lands, cancel/swipe/back never clocks anyone in.

#### 3.1: Create the route

**File**: `mobile/src/app/clock-in.tsx`

Content is EmployerSheet.tsx:109-192 (title-as-busy-state, membership rows in server order with live distance via `useFixPoll(true)`, personal row, live-region error, Cancel) with this state moved in from the clock screen:

```tsx
const memberships = useSessionStore((s) => s.me?.memberships ?? []);
const fix = useFixPoll(memberships.length > 0);
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
const inFlight = useRef(false); // same synchronous double-tap guard as index.tsx:74

const select = async (employerId: string | null) => {
  if (inFlight.current) return;
  inFlight.current = true;
  setBusy(true);
  setError(null);
  try {
    const { done, message } = await clockInNow(employerId, memberships);
    if (done) router.back();
    else setError(message);
  } catch {
    setError(UNEXPECTED_ERROR);
  } finally {
    inFlight.current = false;
    setBusy(false);
  }
};
```

Layout: root `<View style={{ flex: 1 }}>` (formSheet contract), own background color (`theme.surface`), rows keep their exact `accessibilityLabel`/no-disabled-state semantics (EmployerSheet.tsx:131-158 comments carry over).

Deletions relative to the Modal version — the sheet presentation now owns them:
- backdrop `Pressable` and its a11y-hiding props,
- `accessibilityViewIsModal`,
- `useSafeAreaInsets` bottom padding (sheet is inset by the OS),
- `onRequestClose` (Android back pops the route natively).

Guards:
- `memberships.length === 0` (deep link, or membership revoked between push and mount): render `<Redirect href="/(tabs)/(clock)" />` — nothing to choose.
- Route sits inside `Stack.Protected guard={signedIn}`, so a signed-out deep link never mounts it.
- Cancel row calls `router.back()`. A swipe-dismiss during `busy` matches today's semantics: the request completes either way (EmployerSheet.tsx:23-26 comment).

#### 3.2: Register the route

**File**: `mobile/src/app/_layout.tsx` (Gate, lines 260-271)

Append **after** `entry/[id]` inside the signed-in `Stack.Protected` — the declaration-order hazard documented at _layout.tsx:255-259 forbids anything above `(tabs)`; appending at the end is safe.

```tsx
<Stack.Screen
  name="clock-in"
  options={{
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: true,           // iOS-only; Android ignores
    headerShown: false,
    contentStyle: { backgroundColor: "transparent" }, // liquid glass on iOS 26+
  }}
/>
```

If the installed `expo-router` option typing rejects `"fitToContents"`, fall back to `sheetAllowedDetents: [0.5, 0.9]` and note it with a `ponytail:` comment (upgrade path: literal union lands in a later native-stack typing).

### Task 4: Background-location sheet route

**Goals:**
- Same pitch, native sheet; every path out (Allow, Not now, swipe, Android back) marks the prompt seen exactly once, matching index.tsx:204-217.

#### 4.1: Create the route

**File**: `mobile/src/app/background-location.tsx`

Copy from BackgroundSheet.tsx:41-102 body (title, promise copy, Allow primary, Not now secondary). Employer name arrives as a search param (`useLocalSearchParams<{ employer: string }>`) — snapshot at push time; deriving live from stores would re-derive "Employer" if the membership drops mid-sheet, which is worse.

Answer handling, with dismissal-as-decline:

```tsx
const answered = useRef(false);

const answer = async (allow: boolean) => {
  if (answered.current) return;
  answered.current = true;
  setBusy(true);
  try {
    if (allow && (await requestShiftTracking())) return;
    useUiStore.getState().setTrackingNotice(BACKGROUND_DECLINED);
  } catch {
    // Nothing was asked and nothing can be: no copy claiming the worker chose this.
  } finally {
    useUiStore.getState().markBackgroundPromptSeen();
    router.back();
  }
};

// Swipe-dismiss / Android back = "Not now" without a tap: unmount cleanup covers it.
useEffect(() => {
  return () => {
    if (answered.current) return;
    answered.current = true;
    useUiStore.getState().setTrackingNotice(BACKGROUND_DECLINED);
    useUiStore.getState().markBackgroundPromptSeen();
  };
}, []);
```

`BACKGROUND_DECLINED` copy moves here from the clock screen. Note `router.back()` inside `answer` runs before unmount cleanup; the `answered` ref keeps the two paths mutually exclusive.

#### 4.2: Register the route

**File**: `mobile/src/app/_layout.tsx`

Same options as 3.2 (formSheet, fitToContents, grabber, no header, transparent content), appended after `clock-in`.

### Task 5: Rewire clock screen

**File**: `mobile/src/app/(tabs)/(clock)/index.tsx`

#### 5.1: Employer path pushes the sheet

- Delete `sheetOpen`, the `<EmployerSheet …/>` element, and the `!sheetOpen &&` guard on the inline error (index.tsx:343) — `error` now only ever comes from clock-out/personal-in, which happen on this screen.
- Button branch becomes:

```tsx
} else if (hasEmployers) {
  router.push("/clock-in");
} else {
```

- `run()` stays for `clockOutNow` and `clockInNow(null, [])`.

#### 5.2: Focus-guarded background push

Replace the conditional `<BackgroundSheet …/>` mount (index.tsx:409-417) and `answerBackground`/`askingBackground` with a push that fires only while this screen has focus — this is what prevents the background sheet from stacking on top of the still-open clock-in sheet (store updates land before the sheet's `router.back()`):

```tsx
useFocusEffect(
  useCallback(() => {
    if (!askBackground) return;
    router.push({
      pathname: "/background-location",
      params: { employer: employerName },
    });
  }, [askBackground, employerName]),
);
```

`askBackground` (index.tsx:197-202) is unchanged. After the route answers, `markBackgroundPromptSeen` flips the condition false, so re-focus cannot re-push. Web parity note: the condition can only pass where `useBackgroundPermissions` reports an askable state, same as the Modal today — behavior unchanged.

#### 5.3: Render the store notice

Replace local `notice` state with `const notice = useUiStore((s) => s.trackingNotice)`. Clear it where the old code cleared it (`run()` start: a new tap makes it stale — index.tsx:81-83) via `setTrackingNotice(null)`. Rendering block (index.tsx:351-355) unchanged.

### Task 6: Delete Modal sheets

**Files**: `mobile/src/components/EmployerSheet.tsx`, `mobile/src/components/BackgroundSheet.tsx`

Delete both. Grep confirms the clock screen is their only consumer. Carry the load-bearing comments (rows never `accessibilityState.disabled`, membership order never distance-sorted, radius-is-a-client-copy) into the new routes — they answer "why not simpler" questions that will recur.

### Task 7: Verification

#### 7.1: Static + unit

```sh
cd mobile && npx tsc --noEmit && npx expo-doctor && npm test
```

#### 7.2: On-device (dev build; requires a signed-in session against the local stack)

- iOS: sheet rises with grabber, sized to content; swipe-dismiss cancels without clocking in; VoiceOver focus is trapped in the sheet (UIKit modality — no manual flag); refusal (out-of-range clock-in) keeps sheet open with the live-region error; success closes it and the card flips to "On shift".
- iOS 26 simulator: transparent contentStyle renders liquid glass.
- Android: Material bottom sheet; hardware back = cancel; TalkBack reads each row's name + distance + range state.
- Background pitch: first employer clock-in raises it after the clock-in sheet closes (never stacked); Allow triggers the OS flow; swipe-dismiss shows the "Check-ins are off…" notice on the clock screen and never re-prompts (relaunch included).
- Web (`npm run web`): "/clock-in" renders as a plain page; select + cancel both navigate back.
