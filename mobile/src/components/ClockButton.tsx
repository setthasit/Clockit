import { useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";

import { theme } from "@/lib/theme";

const SIZE = 180;

type Props = {
  /** "Clock in" or "Clock out" — the caller owns which shift state it is. */
  label: string;
  onPress: () => void;
  /** A clock request is in flight: spinner instead of the label, taps ignored. */
  busy?: boolean;
  /** Unavailable for a reason the caller explains next to the button. */
  disabled?: boolean;
};

/**
 * The one control the whole app exists for. Its own file because the screen already owns three
 * states' worth of layout, and task 6.4 drives this from the clock flow without touching it.
 *
 * Plain `Animated`, not the installed Reanimated: a press scale is one interpolated transform with
 * no gesture to track and no per-frame JS, which `useNativeDriver` already hands to the UI thread.
 * Reanimated would add a worklet compile step and a second animation runtime to save nothing.
 */
export function ClockButton({
  label,
  onPress,
  busy = false,
  disabled = false,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const inert = busy || disabled;

  const animate = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 40,
      bounciness: 4,
    }).start();

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        // The label is the only text inside, and the spinner replaces it while busy — without this
        // a screen reader announces an unnamed button for the whole request.
        accessibilityLabel={label}
        accessibilityState={{ disabled: inert, busy }}
        disabled={inert}
        onPress={onPress}
        onPressIn={() => animate(0.96)}
        onPressOut={() => animate(1)}
        style={[styles.button, disabled && styles.blocked]}
      >
        {busy ? (
          // Same fill-dependent swap as the label below, should busy and blocked ever overlap.
          <ActivityIndicator color={disabled ? theme.surface : theme.onBrand} size="large" />
        ) : (
          // The circle is a fixed 180 pt, so at the largest Dynamic Type sizes the label has to
          // shrink rather than wrap out of it.
          <Text
            adjustsFontSizeToFit
            numberOfLines={1}
            // Blocked swaps the fill to `muted`, which flips light in dark mode — static onBrand
            // white would fail contrast there, while `surface` flips opposite and stays readable.
            style={[styles.label, disabled && styles.blockedLabel]}
            // ponytail: iOS shrinks to fit, Android only ever picks smaller sizes for a *bounded*
            // box, which this Text has (the circle). Both land inside; the sizes may differ.
          >
            {label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.m,
    backgroundColor: theme.brand,
  },
  // Busy keeps the brand fill — the button is working, not unavailable.
  blocked: { backgroundColor: theme.muted },
  label: { color: theme.onBrand, fontSize: 24, fontWeight: "700" },
  blockedLabel: { color: theme.surface },
});
