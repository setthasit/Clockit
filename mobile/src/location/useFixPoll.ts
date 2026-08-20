import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

import type { Fix } from "@/api/types";
import { getFix } from "@/location/fix";

const FIX_POLL_MS = 15_000;

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
// Not worth a lastReadAt ref — but consumers (the clock screen and the clock-in sheet) must not
// inherit the stronger reading.
//
// First read fires immediately: waiting 15 s to say anything would mean the badge is still
// "Checking distance…" for most of the time a worker spends on this screen before tapping.
export function useFixPoll(active: boolean): Fix | null {
  const [fix, setFix] = useState<Fix | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!active) return;
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
    }, [active]),
  );

  return fix;
}
