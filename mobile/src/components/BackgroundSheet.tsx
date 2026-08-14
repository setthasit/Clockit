import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { theme } from "@/lib/theme";

type Props = {
  visible: boolean;
  /** The employer whose shift is running — named in the copy, because "your employer" is vaguer
   * than the worker's own situation warrants. */
  employerName: string;
  /** The OS request is in flight (or, on Android 11+, the settings page is opening). */
  busy?: boolean;
  /** Ask the OS. The screen owns what happens with the answer. */
  onAllow: () => void;
  /** "Not now", the backdrop, or Android back. The shift is unaffected either way. */
  onDismiss: () => void;
};

/**
 * The pitch for Always location, put once, at the first employer shift — where the need is
 * concrete and the worker can see what it is for. /permissions asks for foreground only and says
 * this is coming; this is the follow-through.
 *
 * The second sentence is the one that matters and is deliberately a promise about what the
 * employer sees, not about what the phone does: design §5.4 is explicit that pings are
 * supplementary evidence surfaced as "last seen", never a live map. Saying anything stronger here
 * would be selling a feature the employer UI refuses to build.
 *
 * Plain RN Modal, matching EmployerSheet — see that file for why @expo/ui's BottomSheet is not
 * used (its rows cannot be labelled for TalkBack).
 */
export function BackgroundSheet({
  visible,
  employerName,
  busy = false,
  onAllow,
  onDismiss,
}: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Android's back button and gesture. Dismissing is a real answer here — "not now" — so it
      // routes to the same handler as the button rather than being suppressed.
      onRequestClose={onDismiss}
    >
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        accessibilityElementsHidden
        onPress={onDismiss}
        style={styles.backdrop}
      />

      <View
        // UIKit leaves the screen behind a transparent modal in the accessibility tree, and RN
        // never sets this itself: without it VoiceOver swipes past this card onto the clock button.
        accessibilityViewIsModal
        style={[styles.sheet, { paddingBottom: insets.bottom + theme.spacing.s }]}
      >
        <Text accessibilityRole="header" style={styles.title}>
          Keep recording while you work?
        </Text>
        <Text style={styles.body}>
          You&apos;re on shift with {employerName}. If you allow location all
          the time, ClockIt checks in about every 10 minutes until you clock
          out.
        </Text>
        <Text style={styles.body}>
          {employerName} sees that your shift is still running — not a live map,
          and nothing at all once you clock out.
        </Text>
        <Text style={styles.note}>
          Say no and your shift is recorded exactly the same. Only the check-ins
          in between are missing.
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={onAllow}
          style={({ pressed }) => [
            styles.primary,
            (pressed || busy) && styles.pressed,
          ]}
        >
          <Text style={styles.primaryLabel}>Allow while on shift</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onDismiss}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryLabel}>Not now</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: theme.radius.m,
    borderTopRightRadius: theme.radius.m,
    padding: theme.spacing.l,
    gap: theme.spacing.s,
  },
  title: { color: theme.text, fontSize: 20, fontWeight: "700" },
  body: { color: theme.text, fontSize: 15, lineHeight: 21 },
  note: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.s,
    borderRadius: theme.radius.m,
    backgroundColor: theme.brand,
  },
  primaryLabel: { color: theme.surface, fontSize: 16, fontWeight: "600" },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: theme.muted, fontSize: 16 },
  pressed: { opacity: 0.7 },
});
