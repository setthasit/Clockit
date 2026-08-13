import * as Location from "expo-location";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "@/lib/theme";
import { useUiStore } from "@/stores/ui";

/**
 * The pre-prompt App Review expects before an Always-location app asks for anything, and plain
 * decent UX: the OS prompt fires once per install, and a worker who denies it cold cannot be
 * re-asked from inside the app.
 *
 * Rendered two ways: short-circuited by the gate in _layout.tsx on the first launch that needs it,
 * and as the normal /permissions route later (task 8.1's profile screen links here). Both paths
 * end in dismiss(), which is why nothing here assumes a navigator exists.
 *
 * It requests foreground only. Background is asked at the first clock-in (phase 5), when the need
 * is concrete — the strings below still explain it, because app.config.ts already declares the
 * Always usage descriptions and this screen is the justification reviewers read.
 */
export default function Permissions() {
  const markSeen = useUiStore((s) => s.markLocationExplainerSeen);
  const [asking, setAsking] = useState(false);

  const dismiss = () => {
    markSeen();
    // canGoBack() answers false when no navigator has mounted yet (expo-router
    // global-state/router.js documents that exact root-layout case), which is the gate rendering.
    // There, flipping the flag above is what moves the user on: the gate re-renders into the Stack
    // and lands on (tabs). As a route, this pops back to wherever the link came from.
    if (router.canGoBack()) router.back();
  };

  const allow = async () => {
    setAsking(true);
    try {
      // The answer is deliberately not branched on: both outcomes leave the app usable, and the
      // clock screen (task 6.1) reads the live status itself rather than trusting a stored copy.
      await Location.requestForegroundPermissionsAsync();
    } finally {
      dismiss();
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.body}>
        <SymbolView
          name={{ ios: "location.circle.fill", android: "location_on" }}
          size={72}
          tintColor={theme.brand}
        />
        <Text accessibilityRole="header" style={styles.title}>
          Why ClockIt needs your location
        </Text>
        <Text style={styles.lead}>
          ClockIt checks you&apos;re at the right place only when you clock
          in/out, and records your location during shifts.
        </Text>
        <Text style={styles.point}>
          <Text style={styles.pointLabel}>Clocking in or out.</Text> One reading
          confirms you are at your workplace, so your hours can be trusted
          without anyone checking up on you.
        </Text>
        <Text style={styles.point}>
          <Text style={styles.pointLabel}>During a shift.</Text> Your location is
          recorded from clock-in until clock-out. Never before, never after —
          off shift, ClockIt does not look.
        </Text>
        <Text style={styles.note}>
          Next you&apos;ll see your phone&apos;s own permission prompt. We ask
          for background location later, only if you start a shift.
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={asking}
        onPress={allow}
        style={({ pressed }) => [
          styles.primary,
          (pressed || asking) && styles.pressed,
        ]}
      >
        <Text style={styles.primaryLabel}>Continue</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={asking}
        onPress={dismiss}
        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
      >
        <Text style={styles.secondaryLabel}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // paddingBottom is generous rather than inset-aware: as a gate short-circuit this screen renders
  // with no header and no tab bar, and 40pt clears the iOS home indicator without a hook.
  screen: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: theme.surface,
    padding: theme.spacing.l,
    paddingBottom: 40,
  },
  body: { flex: 1, justifyContent: "center", gap: theme.spacing.m },
  title: { color: theme.text, fontSize: 24, fontWeight: "700" },
  lead: { color: theme.text, fontSize: 16, lineHeight: 22 },
  point: { color: theme.muted, fontSize: 15, lineHeight: 21 },
  pointLabel: { color: theme.text, fontWeight: "600" },
  note: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.m,
    backgroundColor: theme.brand,
  },
  primaryLabel: { color: theme.surface, fontSize: 16, fontWeight: "600" },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.s,
  },
  secondaryLabel: { color: theme.muted, fontSize: 16 },
  pressed: { opacity: 0.7 },
});
