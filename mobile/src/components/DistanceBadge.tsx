import { StyleSheet, Text, View } from "react-native";

import type { Membership } from "@/api/me";
import type { Fix } from "@/api/types";
import { formatDistance } from "@/lib/format";
import { theme } from "@/lib/theme";
import { distanceM, inRange } from "@/location/fix";

type Props = {
  /** /v1/me returns active memberships only (api/me.ts), so there is nothing here to filter. */
  memberships: Membership[];
  /** Latest reading from the screen's poller: null before the first one lands, or after one failed. */
  fix: Fix | null;
};

/**
 * "620 m from Acme Cafe — in range", so a worker knows before they tap whether the server is
 * likely to accept. Pure render: the screen owns the fix (one poller for this and task 6.3's
 * EmployerSheet, which reads the same fix and computes its own per-membership distances).
 *
 * The copy describes the *distance*, never the outcome — inRange only mirrors the anchor radius
 * as this build knows it (fix.ts documents that the real one is never sent on the wire), and the
 * button stays enabled either way. This badge disables nothing and blocks nothing.
 */
export function DistanceBadge({ memberships, fix }: Props) {
  // ponytail: a fix that never arrives (services off mid-session, indoors on a timeout loop) reads
  // "Checking distance…" forever rather than surfacing LocationError's copy. Deliberate: a
  // pre-check failure is not the worker's problem — the tap still works and the server still
  // decides, so alarming them here would be noise. Ceiling: no way to tell "still trying" from
  // "will never work". Upgrade path: task 6.4 gets the same rejection at tap time, where it *is*
  // actionable, and can show the message with the retry.
  //
  // fix.accuracy is deliberately not consulted below either, so a 150 m-accuracy indoor fix can
  // render "80 m — in range". That costs a dialog and never a server rejection: task 6.4 catches
  // accuracy > 100 locally with a "GPS weak — try anyway?" confirm before any request, and owns
  // that check for both this badge and the EmployerSheet.
  if (!fix) {
    return (
      <View style={styles.badge}>
        <Text style={styles.checking}>Checking distance…</Text>
      </View>
    );
  }

  // Strict `<` keeps the first of a tie, i.e. the server's membership order — arbitrary but stable,
  // so the name does not flip between two equidistant employers on every poll.
  const nearest = memberships.reduce<{ m: Membership; d: number } | null>(
    (best, m) => {
      const d = distanceM(fix, m.employer.anchor);
      return !best || d < best.d ? { m, d } : best;
    },
    null,
  );
  // The screen only mounts this with memberships, but an empty array must render nothing rather
  // than an empty badge — a zero-membership user clocks in personally with no employer UI at all.
  if (!nearest) return null;

  // inRange rather than `d <= 1000`: the server rounds to whole metres before comparing, so it
  // accepts 1000.3 m and a naive compare here would call that out of range.
  const ok = inRange(fix, nearest.m.employer.anchor);
  const label = `${formatDistance(nearest.d)} from ${nearest.m.employer.name} — ${ok ? "in range" : "out of range"}`;

  return (
    <View style={styles.badge}>
      {/* One accessible node with an explicit label so the glyph is not announced as "check mark",
          and deliberately not a live region: the words "in range" / "out of range" already carry
          the state without colour, and re-announcing a number that moves every 15 s would make the
          screen unusable with a screen reader. */}
      <Text
        accessible
        accessibilityLabel={label}
        style={[styles.label, ok ? styles.ok : styles.out]}
      >
        {ok ? "✓ " : ""}
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: "center", paddingHorizontal: theme.spacing.m },
  label: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  checking: { color: theme.muted, fontSize: 15, textAlign: "center" },
  ok: { color: theme.ok },
  out: { color: theme.danger },
});
