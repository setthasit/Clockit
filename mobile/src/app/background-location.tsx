import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "@/lib/theme";
import { requestShiftTracking } from "@/location/tracking";
import { useUiStore } from "@/stores/ui";

// Shown once, after the on-shift tracking pitch is turned down. Deliberately says nothing about
// *why* it is off: on Android 11+ the request opens Settings rather than a dialog, so at this
// point the app genuinely does not know whether the worker refused or is still deciding. Both
// readings are true of this sentence, and both have the same consequence.
const BACKGROUND_DECLINED =
  "Check-ins are off. Your shift still records — your employer just won't see it running in between.";

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
 * A route presented as `formSheet` (see clock-in.tsx for the full presentation rationale).
 * Dismissal is an answer — "not now" — handled by unmount cleanup rather than onRequestClose.
 */
export default function BackgroundLocation() {
  // Snapshot at push time: deriving live from stores would re-derive "Employer" if the membership
  // drops mid-sheet. The fallback matches the clock screen's revoked-membership fallback, and only
  // a hand-typed deep link hits it.
  const { employer = "Employer" } = useLocalSearchParams<{ employer: string }>();
  const [busy, setBusy] = useState(false);
  // `router.back()` inside answer() runs before unmount cleanup; this ref keeps the two paths
  // mutually exclusive, so every way out marks the prompt seen exactly once.
  const answered = useRef(false);

  // Every path out of this sheet marks the prompt seen: asking again on the next shift would turn
  // the pitch into a nag.
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

  return (
    <View style={styles.sheet}>
      <Text accessibilityRole="header" style={styles.title}>
        Keep recording while you work?
      </Text>
      <Text style={styles.body}>
        You&apos;re on shift with {employer}. If you allow location all
        the time, ClockIt checks in about every 10 minutes until you clock
        out.
      </Text>
      <Text style={styles.body}>
        {employer} sees that your shift is still running — not a live map,
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
        onPress={() => void answer(true)}
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
        onPress={() => void answer(false)}
        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
      >
        <Text style={styles.secondaryLabel}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // flex: 1 is the formSheet contract: the sheet sizes to its detent and this view fills it.
  sheet: {
    flex: 1,
    backgroundColor: theme.surface,
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
