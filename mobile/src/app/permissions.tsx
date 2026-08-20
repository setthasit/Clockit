import * as Location from "expo-location";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  const insets = useSafeAreaInsets();
  const [asking, setAsking] = useState(false);

  // ponytail: dismissing is a one-way door. "Not now" leaves the OS status UNDETERMINED and flips
  // the flag, and no shipped screen links to /permissions yet, so that user has no way back to the
  // pitch — nor to iOS Settings, which shows no Location row for an app that never requested.
  // Ceiling: a worker who taps "Not now" cannot clock in until reinstall. Upgrade path: task 6.1's
  // disabled-clock state (which owns the Settings deep link) and task 8.1's profile link here.
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
    } catch {
      // A throw means no prompt was ever shown (missing native module, or a web build). Dismissing
      // here would retire this screen for good — see the one-way door above — for someone who was
      // never actually asked, so stay put and re-enable the buttons instead.
      setAsking(false);
      return;
    }
    dismiss();
  };

  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: insets.top + theme.spacing.l,
          paddingBottom: insets.bottom + theme.spacing.l,
        },
      ]}
    >
      {/* Its own, rather than inherited from (tabs)/_layout.tsx: on a first launch the gate
          renders this screen directly, before any navigator exists, so nothing else is mounted
          to make the icons track the scheme this `theme.surface` background follows — "auto" is
          dark icons on the light surface, white on the dark one. */}
      <StatusBar style="auto" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        {/* Decorative: SymbolView forwards no a11y props, and on Android it renders a bare <Text>
            glyph that TalkBack would otherwise stop on and read as a character. */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <SymbolView
            name={{ ios: "location.circle.fill", android: "location_on" }}
            size={72}
            tintColor={theme.brandTint}
          />
        </View>
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
          Tap Continue and you&apos;ll see your phone&apos;s own permission
          prompt. We ask for background location later, only if you start a
          shift.
        </Text>
      </ScrollView>

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
  // Insets are applied inline, not baked in here: as a gate short-circuit this screen renders with
  // no header and no tab bar, so both the status bar and the home indicator are its own problem.
  // useSafeAreaInsets() works even under the gate — expo-router's ExpoRoot mounts a
  // SafeAreaProvider (with initialMetrics) around the entire tree, above the root layout.
  screen: {
    flex: 1,
    backgroundColor: theme.surface,
    paddingHorizontal: theme.spacing.l,
  },
  // A ScrollView only scrolls when its own height is bounded; without flex it would size to its
  // content and overflow the screen exactly like the View it replaced.
  scroll: { flex: 1 },
  // The copy is long and grows with Dynamic Type: a plain View would clip it, since RN does not
  // scroll overflow. flexGrow keeps it optically centred until it no longer fits, then it scrolls.
  body: { flexGrow: 1, justifyContent: "center", gap: theme.spacing.m },
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
  primaryLabel: { color: theme.onBrand, fontSize: 16, fontWeight: "600" },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.spacing.s,
  },
  secondaryLabel: { color: theme.muted, fontSize: 16 },
  pressed: { opacity: 0.7 },
});
