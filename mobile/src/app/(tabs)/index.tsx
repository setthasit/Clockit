import * as Location from "expo-location";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ClockButton } from "@/components/ClockButton";
import { formatClock, formatDuration } from "@/lib/format";
import { theme } from "@/lib/theme";
import { useClockStore } from "@/stores/clock";
import { useSessionStore } from "@/stores/session";

export default function Clock() {
  const openEntry = useClockStore((s) => s.openEntry);
  const pendingSince = useClockStore((s) => s.pendingSince);
  const hydrateFromServer = useClockStore((s) => s.hydrateFromServer);
  const memberships = useSessionStore((s) => s.me?.memberships);
  // Never auto-requests; the explainer at /permissions owns the prompt. `permission` is null until
  // the first read resolves, which is why "blocked" below is not simply `!granted`.
  const [permission, , refreshPermission] = Location.useForegroundPermissions();
  const [now, setNow] = useState(() => Date.now());

  // Once per launch, not per focus: this tab is the navigator's first screen, so it mounts at
  // launch and stays mounted. The rejection is swallowed on purpose — hydrateFromServer never
  // clears state when it fails, so an offline launch keeps whatever was on screen instead of
  // raising a red box at someone who is simply in a dead zone. Re-hydrating on reconnect and on
  // foreground belongs to task 9.1's trigger list, alongside the outbox flush.
  useEffect(() => {
    hydrateFromServer().catch(() => {});
  }, [hydrateFromServer]);

  // Derived from clock_in.at every render rather than incremented, so a backgrounded phone (where
  // JS timers are throttled or stopped outright) needs no resume handling: the first tick after
  // the app comes back computes the true value from the timestamp. Only the *sampling* has to be
  // stopped while the screen is away — a 1 s interval behind the History tab is pure battery.
  //
  // This re-renders one screen per second to move a value that changes once a minute. That is the
  // trade stores/clock.ts deliberately chose over a store field, which would have re-rendered
  // every subscriber instead. Cheaper-than-a-render dedupe (comparing formatted strings inside the
  // interval) buys nothing measurable here and hides where the value comes from.
  useFocusEffect(
    useCallback(() => {
      if (!openEntry) return;
      setNow(Date.now());
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }, [openEntry]),
  );

  // useForegroundPermissions reads the OS once on mount and has no listener, so without this the
  // button stays dead until relaunch for exactly the users who just fixed the problem: both routes
  // out of the blocked state below either push /permissions (focus returns here) or leave for
  // Settings (the app foregrounds). One of the two covers every way back.
  useFocusEffect(
    useCallback(() => {
      refreshPermission().catch(() => {});
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") refreshPermission().catch(() => {});
      });
      return () => sub.remove();
    }, [refreshPermission]),
  );

  // Whole minutes: formatDuration rounds, and a stopwatch that reads "1m" 30 seconds in is wrong
  // in the direction that matters when the number is someone's pay. The first minute shows "0m",
  // which reads fine beside the "On shift since 9:02" line that gives it context.
  const elapsed = openEntry
    ? formatDuration(
        Math.floor((now - Date.parse(openEntry.clock_in.at)) / 60000),
      )
    : null;

  // A membership can be revoked while its shift is still running, so the id may resolve to nothing
  // — the shift is real either way and must not read as "Personal", which is a different thing.
  const employerName = openEntry?.employer_id
    ? (memberships?.find((m) => m.employer.id === openEntry.employer_id)
        ?.employer.name ?? "Employer")
    : "Personal";

  const granted = permission?.granted === true;
  const blocked = permission != null && !granted;

  return (
    <View style={styles.screen}>
      {/* One accessible element: three separate labels would make a screen reader walk through
          "Personal", "On shift since 9:02", "3h 41m" as unrelated stops. Deliberately not a live
          region — announcing the elapsed time again every minute would be hostile. */}
      <View accessible style={styles.card}>
        {openEntry ? (
          <>
            <Text style={styles.employer}>{employerName}</Text>
            <Text style={styles.since}>
              On shift since {formatClock(openEntry.clock_in.at)}
            </Text>
            <Text style={styles.elapsed}>{elapsed}</Text>
          </>
        ) : (
          // ponytail: no last-shift summary. Nothing caches closed entries, and the only source is
          // listEntries() over an unbounded window — the same call hydrateFromServer already makes
          // and throws away, at ~2 decrypts per entry server-side. A second copy of the user's
          // whole coordinate history on the wire, every launch, to render one line. Upgrade path:
          // take the newest closed entry from a list the app already has — task 7.1's history cache,
          // or clock.ts's hydrate once task 5.1's `status=open` filter stops it fetching everything.
          <Text style={styles.employer}>Clocked out</Text>
        )}
      </View>

      {pendingSince != null && (
        <View style={styles.pill}>
          <Text style={styles.pillLabel}>Waiting for connection</Text>
        </View>
      )}

      <View style={styles.center}>
        <ClockButton
          label={openEntry ? "Clock out" : "Clock in"}
          disabled={!granted}
          // Task 6.4 owns the flow: employer sheet, getFix(), optimistic write, error mapping.
          onPress={() => {}}
        />

        {blocked && (
          <View style={styles.blocked}>
            <Text style={styles.blockedText}>
              ClockIt needs your location to record where you clock in and out.
            </Text>
            {/* canAskAgain, not the status: it is the one flag that answers "will the OS still show
                a prompt". True covers the "Not now" cohort, who left the status undetermined and
                until now had no way back to the explainer, and Android's re-askable denial. False
                means only Settings can change it — and iOS shows a Location row there once the app
                has asked at least once, which by then it has. */}
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                permission?.canAskAgain
                  ? router.push("/permissions")
                  : Linking.openSettings().catch(() => {})
              }
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Text style={styles.actionLabel}>
                {permission?.canAskAgain ? "Turn on location" : "Open settings"}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No safe-area insets: this screen renders inside the tab navigator, which owns the header and
  // the tab bar and has already inset both edges.
  screen: {
    flex: 1,
    backgroundColor: theme.surface,
    padding: theme.spacing.l,
    gap: theme.spacing.m,
  },
  card: {
    backgroundColor: theme.brand,
    borderRadius: theme.radius.m,
    padding: theme.spacing.l,
    gap: theme.spacing.s,
  },
  employer: { color: theme.surface, fontSize: 20, fontWeight: "700" },
  since: { color: theme.surface, fontSize: 15, opacity: 0.85 },
  elapsed: { color: theme.surface, fontSize: 34, fontWeight: "700" },
  // Outlined rather than filled: "subtle" per the plan, and muted-on-white clears 4.5:1 where
  // white-on-muted would not at this size.
  pill: {
    alignSelf: "center",
    borderWidth: 1,
    borderColor: theme.muted,
    borderRadius: theme.radius.full,
    paddingVertical: theme.spacing.s / 2,
    paddingHorizontal: theme.spacing.m,
  },
  pillLabel: { color: theme.muted, fontSize: 13 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.l,
  },
  blocked: { alignItems: "center", gap: theme.spacing.s },
  blockedText: {
    color: theme.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  action: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.m,
  },
  actionLabel: { color: theme.brand, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.7 },
});
