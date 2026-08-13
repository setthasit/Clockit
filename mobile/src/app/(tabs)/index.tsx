import * as Location from "expo-location";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { Fix } from "@/api/types";
import { ClockButton } from "@/components/ClockButton";
import { DistanceBadge } from "@/components/DistanceBadge";
import { EmployerSheet } from "@/components/EmployerSheet";
import {
  type ClockResult,
  clockInNow,
  clockOutNow,
  UNEXPECTED_ERROR,
} from "@/lib/clockFlow";
import { formatClock, formatDuration } from "@/lib/format";
import { theme } from "@/lib/theme";
import { getFix } from "@/location/fix";
import { useClockStore } from "@/stores/clock";
import { useSessionStore } from "@/stores/session";

const FIX_POLL_MS = 15_000;

export default function Clock() {
  const openEntry = useClockStore((s) => s.openEntry);
  const lastClosed = useClockStore((s) => s.lastClosed);
  const pendingSince = useClockStore((s) => s.pendingSince);
  const hydrateFromServer = useClockStore((s) => s.hydrateFromServer);
  const memberships = useSessionStore((s) => s.me?.memberships);
  // Never auto-requests; the explainer at /permissions owns the prompt. `permission` is null until
  // the first read resolves, which is why "blocked" below is not simply `!granted`.
  const [permission, , refreshPermission] = Location.useForegroundPermissions();
  const [now, setNow] = useState(() => Date.now());
  // Owned here, not inside DistanceBadge: task 6.3's EmployerSheet needs a live distance per
  // membership from the same reading, and two 15 s pollers on one screen would be a defect. The
  // badge and the sheet both take this as a prop and do their own arithmetic with distanceM.
  const [fix, setFix] = useState<Fix | null>(null);
  const [foreground, setForeground] = useState(true);
  // The sheet is controlled from here, not self-managing: task 6.4 needs to keep it open while a
  // request is in flight and close it only once the write lands.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The actual concurrency guard. `busy` renders the spinner and inerts the controls, but state
  // updates land on the next render, so two taps dispatched in one JS tick would both read
  // `busy === false` and start two clock-ins — the single worst outcome this app has. A ref is
  // written synchronously, so the second tap sees it before the first has awaited anything.
  const inFlight = useRef(false);

  const run = useCallback(async (act: () => Promise<ClockResult>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { done, message } = await act();
      setError(message);
      if (done) setSheetOpen(false);
    } catch {
      // clockFlow resolves rather than rejects for everything it owns, so this is a bug in ours
      // (or in a phase-5 tracking hook). Caught anyway: the alternative is an unhandled rejection
      // and a button that has already committed an optimistic write with no way to say so.
      setError(UNEXPECTED_ERROR);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  // Once per launch, not per focus: this tab is the navigator's first screen, so it mounts at
  // launch — and remounts if the gate drops the Stack for a spinner (_layout.tsx:141-147, which
  // onUnauthorized triggers mid-session by clearing `me`). The re-fire on recovery is the point:
  // a session that just came back should refetch, and writeGen makes a late answer safe. The
  // rejection is swallowed on purpose — hydrateFromServer never
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
  //
  // Keyed on the timestamp the interval actually reads, not on `openEntry`: every hydrate parses a
  // fresh object from JSON, so an identity dep would tear the interval down and rebuild it
  // mid-shift once task 9.1 hydrates on NetInfo and AppState.
  const startedAt = openEntry?.clock_in.at;
  useFocusEffect(
    useCallback(() => {
      if (!startedAt) return;
      setNow(Date.now());
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }, [startedAt]),
  );

  // useForegroundPermissions reads the OS once on mount and has no listener, so without this the
  // button stays dead until relaunch for exactly the users who just fixed the problem: both routes
  // out of the blocked state below either push /permissions (focus returns here) or leave for
  // Settings (the app foregrounds). One of the two covers every way back.
  //
  // The same listener drives the distance poll's background pause, so there is one AppState
  // subscription on this screen. `!== "background"` rather than `=== "active"`: iOS reports
  // "inactive" for a pulled-down notification centre or an incoming call banner, and treating
  // those as gone would tear the poll down and fire a fresh GPS read every time someone glanced
  // at a notification. currentState is read on focus too — while the tab is blurred this listener
  // is not mounted, so a background/foreground cycle spent on another tab would otherwise leave
  // the flag stuck false and the badge dead until the next AppState change.
  useFocusEffect(
    useCallback(() => {
      refreshPermission().catch(() => {});
      setForeground(AppState.currentState !== "background");
      const sub = AppState.addEventListener("change", (state) => {
        setForeground(state !== "background");
        if (state === "active") refreshPermission().catch(() => {});
      });
      return () => sub.remove();
    }, [refreshPermission]),
  );

  // Whole minutes: formatDuration rounds, and a stopwatch that reads "1m" 30 seconds in is wrong
  // in the direction that matters when the number is someone's pay. The first minute shows "0m",
  // which reads fine beside the "On shift since 9:02" line that gives it context.
  const elapsed = startedAt
    ? formatDuration(Math.floor((now - Date.parse(startedAt)) / 60000))
    : null;

  // Whole shift, so formatDuration's rounding is right here: the ends are fixed, nothing is being
  // watched climb. The optional chain narrows `lastClosed` too, so no non-null assertion.
  const lastShift = lastClosed?.clock_out
    ? `${formatClock(lastClosed.clock_in.at)} – ${formatClock(lastClosed.clock_out.at)} · ${formatDuration(
        (Date.parse(lastClosed.clock_out.at) -
          Date.parse(lastClosed.clock_in.at)) /
          60000,
      )}`
    : null;

  // A membership can be revoked while its shift is still running, so the id may resolve to nothing
  // — the shift is real either way and must not read as "Personal", which is a different thing.
  const employerName = openEntry?.employer_id
    ? (memberships?.find((m) => m.employer.id === openEntry.employer_id)
        ?.employer.name ?? "Employer")
    : "Personal";

  const granted = permission?.granted === true;
  // ponytail: the null guard keeps "Open settings" from flashing on every cold launch, and pays for
  // it with a dead screen — disabled button, no message, no way out — if the OS read rejects and
  // leaves `permission` null forever (same defect as _layout.tsx:177-181). Ceiling: web and dev
  // builds without the native module, for users already past the explainer gate. Upgrade path is
  // that comment's: read the status directly and treat a failure as UNDETERMINED.
  const blocked = permission != null && !granted;

  // Nothing to show while on shift (the pre-check is about clocking *in*), for a personal-only user
  // with no anchor to measure against, or without permission — and nothing to show means nothing to
  // poll. The badge keeps its last reading across a transient "inactive", so `foreground` gates the
  // polling only, not the rendering.
  const hasEmployers = (memberships?.length ?? 0) > 0;
  const showDistance = !openEntry && hasEmployers && granted;
  const polling = showDistance && foreground;

  // Self-chaining timeout, not setInterval: getFix() is bounded by its own 15 s race, exactly the
  // poll period, so an interval could start a second read while the first is still running and then
  // apply them out of order. Waiting FIX_POLL_MS *after* each reading settles makes overlap
  // impossible without a generation counter (stores/clock.ts) — the `cancelled` flag from
  // _layout.tsx is all that is left to need, since only teardown can now race a result. A slow or
  // timing-out fix backs the cadence off on its own, which is the right direction for battery.
  //
  // "Impossible" holds *within* a chain, not across a teardown and restart: a discarded in-flight
  // getFix() still runs natively (fix.ts:60-63), so a background→foreground or blur→focus cycle can
  // leave two native reads overlapping, and rapid tab churn fires one unthrottled read per focus.
  // Not worth a lastReadAt ref — but tasks 6.3 and 6.4 must not inherit the stronger reading.
  //
  // First read fires immediately: waiting 15 s to say anything would mean the badge is still
  // "Checking distance…" for most of the time a worker spends on this screen before tapping.
  useFocusEffect(
    useCallback(() => {
      if (!polling) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async () => {
        try {
          const next = await getFix();
          if (!cancelled) setFix(next);
        } catch {
          // A pre-check that cannot read the GPS is not worth alarming anyone with: the button
          // still works and the server still decides. Caught here so it is never an unhandled
          // rejection, and the error object is deliberately neither inspected nor logged.
          if (!cancelled) setFix(null);
        }
        if (!cancelled) timer = setTimeout(read, FIX_POLL_MS);
      };
      read();
      return () => {
        cancelled = true;
        clearTimeout(timer);
        // Dropped rather than kept: a reading from before the tab was left is a distance the
        // worker may have walked out of, and showing it stale is worse than showing nothing for
        // the moment it takes the immediate read above to replace it.
        setFix(null);
      };
    }, [polling]),
  );

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
          // ponytail: the summary comes from the launch hydrate, so a cold offline launch shows
          // none — absent exactly when the worker cannot check the server themselves. Same for the
          // moment after a clock-out until the next hydrate, since setOpen does not write
          // lastClosed. Ceiling: no persisted copy. Upgrade path is task 7.1's history cache if it
          // does not replace this line outright.
          <>
            <Text style={styles.employer}>Clocked out</Text>
            {lastShift != null && (
              <Text style={styles.since}>Last shift {lastShift}</Text>
            )}
          </>
        )}
      </View>

      {pendingSince != null && (
        // Worth announcing — it appears and disappears on its own. Android-only: RN exposes no iOS
        // equivalent, and the alternative there (AccessibilityInfo.announceForAccessibility) would
        // have to be fired from an effect that also has to decide when *not* to repeat itself.
        <View accessibilityLiveRegion="polite" style={styles.pill}>
          <Text style={styles.pillLabel}>Waiting for connection</Text>
        </View>
      )}

      <View style={styles.center}>
        {/* Above the button rather than under the card: it answers "will this tap work", so it
            belongs where the thumb is looking. */}
        {showDistance && (
          <DistanceBadge memberships={memberships ?? []} fix={fix} />
        )}

        <ClockButton
          label={openEntry ? "Clock out" : "Clock in"}
          busy={busy}
          disabled={!granted}
          // The sheet is the only branch: a clock-out has nothing to choose, and neither does a
          // worker with no memberships — both go straight to the flow.
          onPress={() => {
            if (openEntry) {
              void run(() => clockOutNow(memberships ?? []));
            } else if (hasEmployers) {
              setError(null);
              setSheetOpen(true);
            } else {
              void run(() => clockInNow(null, []));
            }
          }}
        />

        {/* On the screen only while the sheet is closed — an open sheet covers this, and renders
            the same message itself. */}
        {!sheetOpen && error != null && (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        )}

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
              style={({ pressed }) => [
                styles.action,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.actionLabel}>
                {permission?.canAskAgain ? "Turn on location" : "Open settings"}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Same `fix` as the badge — one poller on this screen, two consumers, each doing its own
          arithmetic with distanceM. Renders nothing at all without memberships, which it enforces
          itself. */}
      <EmployerSheet
        visible={sheetOpen}
        memberships={memberships ?? []}
        fix={fix}
        busy={busy}
        error={error}
        // Stays open across the request and closes only once the write is committed — `run` closes
        // it on `done`, so a refusal leaves the choice, and the message, in place.
        onSelect={(employerId) =>
          void run(() => clockInNow(employerId, memberships ?? []))
        }
        onDismiss={() => {
          setSheetOpen(false);
          setError(null);
        }}
      />
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
  // Outlined rather than filled: "subtle" per the plan.
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
  error: {
    color: theme.danger,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
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
