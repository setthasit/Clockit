import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { Entry } from "@/api/entries";
import { formatClock, formatDuration } from "@/lib/format";
import { theme } from "@/lib/theme";
import type { Attention } from "@/stores/outbox";

type Props = {
  entry: Entry;
  /** Resolved by the screen from /v1/me; null ⇒ personal entry, which is a different thing from
   * an employer whose name we could not resolve. */
  employerName: string | null;
  /** Outbox records the screen joined to this entry — usually empty. */
  attention: Attention[];
  /** Omitted ⇒ the row is a record, not a control. The screen decides: an entry the server has
   * never seen has `id: ''` (clockFlow.localEntry), and /entry/[id] has nothing to open for it. */
  onPress?: () => void;
};

const PULSE_MS = 900;

/**
 * One shift.
 *
 * One accessibility node with a composed label, like the clock screen's card: chip, times,
 * duration, flag and warning are five fragments that describe one thing, and a screen reader
 * walking them as five stops would read as five unrelated shifts. The affordance goes in that
 * label rather than in an accessibilityHint — a hint is suppressible on both platforms, and "what
 * happens if I press this" is the one part of a row a screen-reader user cannot infer from the
 * rest of it.
 *
 * Always a Pressable, even when inert: swapping the root element on a prop would change which
 * native view the row is, and role and label already carry the difference truthfully.
 */
export function EntryRow({ entry, employerName, attention, onPress }: Props) {
  const start = formatClock(entry.clock_in.at);
  // `clock_out`, not `status`: the server never writes one on an open entry, and this narrows.
  const end = entry.clock_out ? formatClock(entry.clock_out.at) : null;
  const duration = entry.clock_out
    ? formatDuration(
        (Date.parse(entry.clock_out.at) - Date.parse(entry.clock_in.at)) / 60000,
      )
    : null;
  // Shown because it changes what the employer sees: these hours were asserted by a phone that
  // synced late, not measured at the time. Not the same claim as `location_verified`, and the
  // other flag (`speed_anomaly`) is a reviewer's signal, not the worker's — 7.2 lists them all.
  const backdated = entry.flags.includes("backdated");

  const label = [
    employerName ?? "Personal",
    end ? `${start} to ${end}` : `on shift since ${start}`,
    duration,
    backdated ? "backdated, recorded offline and synced late" : null,
    ...attention.map((a) => `not synced: ${a.message}`),
    onPress ? "opens shift details" : null,
  ]
    .filter((part): part is string => part != null)
    .join(", ");

  return (
    <Pressable
      accessible
      accessibilityLabel={label}
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.pressed]}
    >
      <View style={styles.line}>
        <View
          style={[
            styles.chip,
            employerName ? styles.chipEmployer : styles.chipPersonal,
          ]}
        >
          <Text
            numberOfLines={1}
            style={[
              styles.chipLabel,
              employerName ? styles.chipLabelEmployer : styles.chipLabelPersonal,
            ]}
          >
            {employerName ?? "Personal"}
          </Text>
        </View>
        <Text style={styles.times}>{end ? `${start} – ${end}` : start}</Text>
      </View>

      <View style={styles.line}>
        {duration != null ? (
          <Text style={styles.duration}>{duration}</Text>
        ) : (
          // No running total on a list row: it would need a 1 s interval per row to stay honest,
          // and the clock screen already owns that timer for the one shift it applies to.
          <OnShift />
        )}
        {backdated && <Text style={styles.flag}>Backdated</Text>}
      </View>

      {/* The glyph is decoration — the message carries the meaning, and the composed label above
          is what is announced, so nothing here is announced as "warning sign". */}
      {attention.map((a) => (
        <Text key={a.clientId} style={styles.warn}>
          ⚠ {a.message}
        </Text>
      ))}
    </Pressable>
  );
}

/**
 * Its own component so the animation state exists only for the one row that has an open entry,
 * rather than a ref and two effects per row in a thirty-day list.
 *
 * Plain `Animated` with `useNativeDriver`, not the installed Reanimated — the same call
 * ClockButton documents: one opacity value, no gesture, no per-frame JS.
 */
function OnShift() {
  const focused = useIsFocused();
  // Assumed on until the async read says otherwise, so a reduce-motion user never sees the frames
  // this exists to spare them. A perpetual loop is also a battery cost, which is why `focused`
  // gates it too: a list left on another tab must not keep the UI thread animating.
  const [reduceMotion, setReduceMotion] = useState(true);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (alive) setReduceMotion(on);
      })
      // A platform that cannot answer keeps the safe default: still, not moving.
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion || !focused) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.2,
          duration: PULSE_MS,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: PULSE_MS,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      // Left visible, not wherever the loop was cut: the dot is half of a state indicator, so it
      // must never be stopped mid-fade at 0.2 and read as "off".
      opacity.setValue(1);
    };
  }, [focused, opacity, reduceMotion]);

  return (
    <View style={styles.onShift}>
      <Animated.View style={[styles.dot, { opacity }]} />
      {/* The words, not the pulse, are what say this — the dot alone would be colour and motion
          only, which is unreadable to half the people it is for. */}
      <Text style={styles.onShiftLabel}>On shift</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: theme.spacing.m,
    paddingHorizontal: theme.spacing.l,
    gap: theme.spacing.s,
  },
  pressed: { opacity: 0.6 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.s,
  },
  chip: {
    flexShrink: 1,
    borderWidth: 1,
    borderRadius: theme.radius.full,
    paddingVertical: theme.spacing.s / 2,
    paddingHorizontal: theme.spacing.m,
  },
  // Outline chip follows its label's tint: brand-blue border would vanish on the dark surface.
  chipEmployer: { borderColor: theme.brandTint },
  chipPersonal: { borderColor: theme.muted },
  chipLabel: { fontSize: 13, fontWeight: "600" },
  chipLabelEmployer: { color: theme.brandTint },
  chipLabelPersonal: { color: theme.muted },
  times: { color: theme.text, fontSize: 16, fontWeight: "600" },
  duration: { color: theme.muted, fontSize: 14 },
  flag: { color: theme.warn, fontSize: 13, fontWeight: "600" },
  onShift: { flexDirection: "row", alignItems: "center", gap: theme.spacing.s },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.ok,
  },
  onShiftLabel: { color: theme.ok, fontSize: 14, fontWeight: "600" },
  warn: { color: theme.warn, fontSize: 13, lineHeight: 18 },
});
