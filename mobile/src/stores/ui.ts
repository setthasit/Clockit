import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';

type UiState = {
  hydrated: boolean;
  locationExplainerSeen: boolean;
  /** The on-shift tracking pitch has been put to this worker once. Whatever they answered — a
   * grant, a refusal, or walking away from Android's settings page — it is never put again. */
  backgroundPromptSeen: boolean;
  /** Transient, like `hydrated`: one screen's message about the answer just given. Kept out of
   * partialize so a relaunch cannot resurrect a stale notice. */
  trackingNotice: string | null;
  markLocationExplainerSeen(): void;
  markBackgroundPromptSeen(): void;
  setTrackingNotice(notice: string | null): void;
};

/**
 * Device-scoped UI preferences. Separate from session.ts on purpose: that store holds the access
 * token and the user profile and is deliberately unpersisted, so the two cannot share a `persist`
 * wrapper without writing credentials to AsyncStorage (which is plain files, not the keychain).
 *
 * `locationExplainerSeen` has to survive relaunch. "Not now" leaves the OS permission
 * `undetermined`, so a launch gate keyed on the OS status alone would put the same blocking screen
 * in front of the user every single cold start, forever. `backgroundPromptSeen` is the same rule
 * one shift later: on Android 11+ the Always request opens Settings rather than a dialog, so a
 * worker who backs out of it leaves the status undetermined too, and the pitch would return on
 * every employer shift they ever work.
 *
 * ponytail: still no versioning/migrate. Adding a field needs none — persist's shallow merge
 * leaves an older blob's missing key on its default — so the ceiling is unchanged: a rename of
 * this key silently re-shows both prompts once. Upgrade path: `version` + `migrate` on the first
 * change that *reshapes* a stored field rather than adding one.
 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      // Not persisted (see partialize): rehydration is async, and the gate must not decide before
      // it finishes or it flashes /permissions at a user who already dismissed it. hasHydrated()
      // exists but is not reactive — nothing would re-render the gate when it flips — so the flag
      // lives in state instead.
      hydrated: false,
      locationExplainerSeen: false,
      backgroundPromptSeen: false,
      trackingNotice: null,

      markLocationExplainerSeen: () => set({locationExplainerSeen: true}),
      markBackgroundPromptSeen: () => set({backgroundPromptSeen: true}),
      setTrackingNotice: (notice) => set({trackingNotice: notice}),
    }),
    {
      name: 'clockit-ui',
      storage: createJSONStorage(() => AsyncStorage),
      // `hydrated` is kept out of what gets written, not out of writing: setState() below still
      // goes through persist's wrapped api.setState, so every cold launch rewrites the same
      // `locationExplainerSeen` payload once. One small write, not worth avoiding.
      partialize: ({locationExplainerSeen, backgroundPromptSeen}) => ({
        locationExplainerSeen,
        backgroundPromptSeen,
      }),
      // Runs after rehydration *and* after a read error (persist calls it with the error instead of
      // the state); unconditional so a corrupt or unreadable store leaves the user on the defaults
      // rather than on the gate's spinner forever. ui.test.js pins both failure paths.
      onRehydrateStorage: () => () => useUiStore.setState({hydrated: true}),
    },
  ),
);
