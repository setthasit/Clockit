import { Redirect, router } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { clockInNow, UNEXPECTED_ERROR } from "@/lib/clockFlow";
import { formatDistance } from "@/lib/format";
import { theme } from "@/lib/theme";
import { distanceM, inRange } from "@/location/fix";
import { useFixPoll } from "@/location/useFixPoll";
import { useSessionStore } from "@/stores/session";

/**
 * "Which employer?" for a worker who has more than a personal shift to record. A route presented
 * as `formSheet` (_layout.tsx), not the RN `Modal` it replaced: the sheet is a real
 * UISheetPresentationController on iOS and Material BottomSheetBehavior on Android, while the
 * children stay plain RN views with full a11y props — the TalkBack labelling objection that ruled
 * out `@expo/ui`'s `BottomSheet` (SwiftUI/Compose children behind `RNHostView`, whose
 * ModifierRegistry registers no contentDescription on Android) never applied to this shape.
 * The presentation now owns what the Modal built by hand, so those parts are gone: the backdrop
 * `Pressable` and its a11y-hiding props, `accessibilityViewIsModal`, the `useSafeAreaInsets`
 * bottom padding (see the sheet style note for who owns the bottom edge now), `onRequestClose`
 * (Android back pops the route natively), the `visible` prop machinery, and the
 * `maxHeight: "80%"` bound.
 *
 * Owning its state rather than receiving props: the clock screen's poller tears down when this
 * route takes focus, so the sheet polls for itself, and the selection semantics live here —
 * stays open on refusal (error inline), closes only when the write lands, and cancel/swipe/back
 * never clocks anyone in.
 *
 * Rows out of range are styled down but stay tappable, and are deliberately never marked
 * accessibilityState.disabled: the radius this checks is a hardcoded copy of a server default that
 * never travels on the wire (location/fix.ts), so the client must never be the one to refuse.
 */
export default function ClockIn() {
  // /v1/me returns active memberships only (api/me.ts), so there is nothing here to filter.
  const memberships = useSessionStore((s) => s.me?.memberships ?? []);
  const fix = useFixPoll(memberships.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The actual concurrency guard. `busy` inerts the rows, but state updates land on the next
  // render, so two taps dispatched in one JS tick would both read `busy === false` and start two
  // clock-ins — the single worst outcome this app has. A ref is written synchronously, so the
  // second tap sees it before the first has awaited anything.
  const inFlight = useRef(false);

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

  // Deep link, or membership revoked between push and mount: nothing to choose, so a worker with
  // no memberships lands back on the clock screen instead of an empty sheet.
  if (memberships.length === 0) return <Redirect href="/(tabs)/(clock)" />;

  return (
    <View style={styles.sheet}>
      {/* The title carries the busy state rather than a spinner: the rows below are inert while
          a request is in flight, and a sheet that silently ignores taps reads as broken. */}
      <Text accessibilityRole="header" style={styles.title}>
        {busy ? "Clocking in…" : "Clock in for"}
      </Text>

      {/* Membership order, never nearest-first: `fix` refreshes every 15 s and this sheet can be
          open across a poll, so sorting by distance would slide rows out from under a thumb
          already on its way down. Keyed by membership id for the same reason — the distances
          update live (that is the point of showing them) while the rows stay put.

          ponytail: a plain View, not a ScrollView — react-native-screens 4.x formSheet applies a
          frame correction that only supports a rigid header+ScrollView child shape and mispaints
          anything else (scroll content lands on the title; upstream #2992, won't-fix in 4.x).
          Ceiling: with fitToContents the sheet is clamped to the largest detent, so a worker with
          roughly ten or more memberships loses rows past the fold with no way to scroll to them
          (swipe-dismiss still works, so nothing is ever clocked in blind). Upgrade path: restore
          the ScrollView when RNS 5.x lands its formSheet layout rework. */}
      <View>
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
              onPress={() => select(m.employer.id)}
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
      </View>

      <View style={styles.divider} />

      {/* No distance and no range state, because a personal clock-in has no anchor to miss — its
          own location becomes one. Anything dimmed here would imply a restriction that is not
          there. */}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => select(null)}
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

      {/* Not disabled during busy on purpose — the request completes either way, and trapping
          someone behind a 15 s timeout is worse than letting them close a sheet whose answer
          arrives anyway. */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Text style={styles.cancel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // No flex: 1 — with `fitToContents` react-native-screens positions the sheet container with no
  // bottom constraint so the sheet's height derives strictly from its children
  // (ScreenStackItem.tsx getPositioningStyle); a flex child there has no height source and the
  // content overflows the measured sheet. Bottom padding stands in for the OS inset the old
  // safe-area math covered.
  sheet: {
    backgroundColor: theme.surface,
    paddingHorizontal: theme.spacing.l,
    paddingTop: theme.spacing.m,
    paddingBottom: theme.spacing.s,
  },
  title: {
    color: theme.muted,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    paddingBottom: theme.spacing.s,
  },
  // 48 pt even before the two lines of text push it taller.
  row: {
    minHeight: 48,
    justifyContent: "center",
    paddingVertical: theme.spacing.s,
  },
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
