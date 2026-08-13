import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Membership } from "@/api/me";
import type { Fix } from "@/api/types";
import { formatDistance } from "@/lib/format";
import { theme } from "@/lib/theme";
import { distanceM, inRange } from "@/location/fix";

type Props = {
  visible: boolean;
  /** /v1/me returns active memberships only (api/me.ts), so there is nothing here to filter. */
  memberships: Membership[];
  /** Latest reading from the screen's poller: null before the first one lands, or after one failed. */
  fix: Fix | null;
  /** A clock-in is in flight: selectable rows go inert so a second tap cannot start a second
   * shift. Cancel stays live on purpose — the request completes either way, and trapping someone
   * behind a 15 s timeout is worse than letting them close a sheet whose answer arrives anyway. */
  busy?: boolean;
  /** The mapped refusal from task 6.4, shown here rather than on the screen because a rejected
   * clock-in leaves this sheet open and the message has to be where the eyes already are. */
  error?: string | null;
  /**
   * A row was chosen: employer id, or null for a personal entry — task 6.4 turns null into an
   * omitted `employer_id` (api/entries.ts ClockInBody). Separate from onDismiss because a
   * dismissed sheet must not clock anyone in, and one nullable callback cannot say which happened.
   */
  onSelect: (employerId: string | null) => void;
  /** Backdrop tap, Android back, or Cancel. Never a selection. */
  onDismiss: () => void;
};

/**
 * "Which employer?" for a worker who has more than a personal shift to record. Controlled: task
 * 6.4 owns when it opens and what a selection does, so there is no state here beyond the layout.
 *
 * Plain RN `Modal` rather than `BottomSheet` from `@expo/ui`, which does exist in 57.0.10 (root
 * export, not the `@expo/ui/universal` specifier the plan remembered) but takes SwiftUI/Compose
 * children: RN views need an `RNHostView` wrapper. iOS could still label them — the
 * `accessibilityLabel` modifier maps onto the underlying SwiftUI Button — but Android's
 * ModifierRegistry registers no contentDescription, so a row's "out of range" reason would be
 * unreachable to TalkBack. Rows are the primary control here and that state has to be spoken on
 * both platforms ClockIt ships. `@expo/ui/community/bottom-sheet` sidesteps the labelling (plain
 * RN children, and no new dependency: reanimated and worklets are installed already) but hosts
 * them through `RNHostView`, whose `matchContents` is fixed at mount — more machinery than six
 * rows justify, which is what plan §7.1's "only if it fits without fighting it" is for.
 *
 * Rows out of range are styled down but stay tappable, and are deliberately never marked
 * accessibilityState.disabled: the radius this checks is a hardcoded copy of a server default that
 * never travels on the wire (location/fix.ts), so the client must never be the one to refuse.
 */
export function EmployerSheet({
  visible,
  memberships,
  fix,
  busy = false,
  error = null,
  onSelect,
  onDismiss,
}: Props) {
  const insets = useSafeAreaInsets();

  // Enforced here rather than at the call site so it cannot be got wrong: a worker with no
  // memberships has nothing to choose between and clocks in directly, with no popup at all.
  if (memberships.length === 0) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Android's back button and gesture. iOS fires this too, but only with allowSwipeDismissal,
      // left at its default false: this Modal is transparent, so UIKit's dismiss gesture drags the
      // whole overlay — full-screen backdrop included — instead of the card alone. Cancel below is
      // therefore a real row, not a fallback for the backdrop.
      onRequestClose={onDismiss}
    >
      <Pressable
        // Hidden from screen readers on purpose: a full-screen "Close" button would be the first
        // thing announced, ahead of the choice the sheet exists to offer. Cancel is the way out.
        accessible={false}
        importantForAccessibility="no"
        accessibilityElementsHidden
        onPress={onDismiss}
        style={styles.backdrop}
      />

      <View
        // `transparent` presents over full screen, and UIKit leaves the screen behind in the
        // accessibility tree; RN never sets this itself, so without it VoiceOver swipes past
        // Cancel onto the Clock in button that opened the sheet.
        accessibilityViewIsModal
        style={[
          styles.sheet,
          // ponytail: assumes the dialog is edge-to-edge, which holds while the edge-to-edge flag
          // is on (it forces navigationBarTranslucent). With it off Android self-insets and this
          // adds a small second gap; app.config.ts sets neither way, so check on device and drop
          // the inset if it double-counts.
          { paddingBottom: insets.bottom + theme.spacing.s },
        ]}
      >
        {/* The title carries the busy state rather than a spinner: the rows below are inert while
            a request is in flight, and a sheet that silently ignores taps reads as broken. */}
        <Text accessibilityRole="header" style={styles.title}>
          {busy ? "Clocking in…" : "Clock in for"}
        </Text>

        {/* Membership order, never nearest-first: `fix` refreshes every 15 s and this sheet can be
            open across a poll, so sorting by distance would slide rows out from under a thumb
            already on its way down. Keyed by membership id for the same reason — the distances
            update live (that is the point of showing them) while the rows stay put. */}
        <ScrollView bounces={false} style={styles.list}>
          {memberships.map((m) => {
            const d = fix ? distanceM(fix, m.employer.anchor) : null;
            // inRange rather than `d <= 1000`: the server rounds to whole metres before comparing.
            const out = fix != null && !inRange(fix, m.employer.anchor);
            // A missing fix is "we do not know yet", which must not borrow the out-of-range
            // treatment — the worker may well be standing on the anchor.
            const detail =
              d == null
                ? "Distance unknown"
                : `${formatDistance(d)}, ${out ? "out of range" : "in range"}`;

            return (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                // Explicit rather than relying on child concatenation, which differs by platform.
                // No accessibilityState.disabled: the row still works, and telling a screen-reader
                // user otherwise would be a lie. "Out of range" is in the label, so the state never
                // depends on the muted colour.
                accessibilityLabel={`${m.employer.name}, ${detail}`}
                disabled={busy}
                onPress={() => onSelect(m.employer.id)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text style={[styles.name, out && styles.nameOut]}>
                  {m.employer.name}
                </Text>
                {/* Full strength even when the name is dimmed: this line carries the reason. */}
                <Text
                  style={[
                    styles.detail,
                    out && styles.detailOut,
                    d != null && !out && styles.detailOk,
                  ]}
                >
                  {detail}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.divider} />

        {/* No distance and no range state, because a personal clock-in has no anchor to miss — its
            own location becomes one. Anything dimmed here would imply a restriction that is not
            there. */}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => onSelect(null)}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <Text style={styles.name}>No employer (personal)</Text>
        </Pressable>

        <View style={styles.divider} />

        {/* Announced when it appears: the sheet stays open on a refusal, so nothing else on
            screen changes to tell a screen-reader user the tap was rejected. */}
        {error != null && (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        )}

        <Pressable
          accessibilityRole="button"
          onPress={onDismiss}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  // Bounded so a worker with many employers cannot push the personal row off the screen; the
  // scroller inside shrinks instead, and Cancel and personal stay outside it, always reachable.
  sheet: {
    maxHeight: "80%",
    backgroundColor: theme.surface,
    borderTopLeftRadius: theme.radius.m,
    borderTopRightRadius: theme.radius.m,
    paddingHorizontal: theme.spacing.l,
    paddingTop: theme.spacing.m,
  },
  list: { flexShrink: 1 },
  title: {
    color: theme.muted,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    paddingBottom: theme.spacing.s,
  },
  // 48 pt even before the two lines of text push it taller.
  row: { minHeight: 48, justifyContent: "center", paddingVertical: theme.spacing.s },
  pressed: { opacity: 0.6 },
  name: { color: theme.text, fontSize: 17, fontWeight: "600" },
  // The whole "disabled" treatment: a muted name, no opacity on the row, so the reason below stays
  // at full contrast.
  nameOut: { color: theme.muted },
  detail: { color: theme.muted, fontSize: 14, paddingTop: 2 },
  detailOk: { color: theme.ok },
  detailOut: { color: theme.danger },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.muted },
  error: {
    color: theme.danger,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: theme.spacing.s,
  },
  cancel: { color: theme.brand, fontSize: 17, fontWeight: "600" },
});
