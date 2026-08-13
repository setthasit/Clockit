import AsyncStorage from '@react-native-async-storage/async-storage';
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';

type UiState = {
  hydrated: boolean;
  locationExplainerSeen: boolean;
  markLocationExplainerSeen(): void;
};

/**
 * Device-scoped UI preferences. Separate from session.ts on purpose: that store holds the access
 * token and the user profile and is deliberately unpersisted, so the two cannot share a `persist`
 * wrapper without writing credentials to AsyncStorage (which is plain files, not the keychain).
 *
 * `locationExplainerSeen` has to survive relaunch. "Not now" leaves the OS permission
 * `undetermined`, so a launch gate keyed on the OS status alone would put the same blocking screen
 * in front of the user every single cold start, forever.
 *
 * ponytail: one flag, no versioning/migrate. Ceiling: a rename of this key silently re-shows the
 * explainer once. Upgrade path: add `version` + `migrate` when a second field arrives.
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

      markLocationExplainerSeen: () => set({locationExplainerSeen: true}),
    }),
    {
      name: 'clockit-ui',
      storage: createJSONStorage(() => AsyncStorage),
      // `hydrated` is kept out of what gets written, not out of writing: setState() below still
      // goes through persist's wrapped api.setState, so every cold launch rewrites the same
      // `locationExplainerSeen` payload once. One small write, not worth avoiding.
      partialize: ({locationExplainerSeen}) => ({locationExplainerSeen}),
      // Runs after rehydration *and* after a read error (persist calls it with the error instead of
      // the state); unconditional so a corrupt or unreadable store leaves the user on the defaults
      // rather than on the gate's spinner forever. ui.test.js pins both failure paths.
      onRehydrateStorage: () => () => useUiStore.setState({hydrated: true}),
    },
  ),
);
