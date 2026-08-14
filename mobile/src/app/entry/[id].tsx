import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ApiError } from "@/api/client";
import { assignEmployer, type Entry, listEntries } from "@/api/entries";
import type { Membership } from "@/api/me";
import {
  assignError,
  findEntry,
  flagNotes,
  locationBadge,
} from "@/lib/entryDetail";
import { formatClock, formatDuration } from "@/lib/format";
import { theme } from "@/lib/theme";
import { useClockStore } from "@/stores/clock";
import { useSessionStore } from "@/stores/session";

// The same window the History tab fetches, for the same reason: it is the only window the app ever
// shows, so nothing in the app can link to a shift outside it.
const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

const UNEXPECTED_ERROR = "Something went wrong. Pull down to refresh.";

/**
 * Speaks the assign outcome on iOS, where the live regions below cannot.
 *
 * `accessibilityLiveRegion` is Android-only (RN ViewAccessibility.d.ts:241), so without this the
 * result of an irreversible action is silent on iOS — and the success branch unmounts the button
 * the user was focused on, taking VoiceOver focus with it. The clock tab's connection pill rejected
 * this (app/(tabs)/index.tsx) because it appears on its own and an effect would have to decide when
 * *not* to repeat; here there is nothing to decide, the announcement is one tap's own result.
 *
 * Queued rather than immediate: an unqueued announcement raced against that same unmount is the one
 * VoiceOver drops, and a dropped announcement is the bug this exists to fix. `queue` is iOS-only.
 */
function announce(message: string) {
  if (Platform.OS === "ios") {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, {
      queue: true,
    });
  }
}

/**
 * One shift, in full.
 *
 * The entry is fetched here rather than handed over from the list. There is no GET /v1/entries/:id
 * — RegisterRoutes (backend/internal/entry/handler.go:43-54) exposes list, clock-in, clock-out,
 * assign and pings, and nothing else — so the 30-day list is the only way to read one entry, and a
 * cold start or a deep link onto this route has no list to inherit from. Router params were the
 * alternative and they fail exactly there: an Entry serialised into a URL is a snapshot with no
 * source, so a relaunch on this screen would show nothing. Since the fetch has to exist for that
 * case, passing the entry as well would only add a second copy that can disagree with it.
 *
 * The cost is real and known: GET /v1/entries decrypts every point in the window server-side
 * (stores/clock.ts:106-111 documents it). One request per opened shift, on a screen a worker opens
 * deliberately, is the cheap end of that — and the same request the tab behind this one just made.
 *
 * ponytail: an entry older than 30 days is unreachable here, which no in-app link can reach anyway
 * (History shows the same window). A shared deep link to an older shift lands on "not in your last
 * 30 days". Upgrade path: pass `from` down from the link, or add the single-entry route.
 */
export default function EntryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();

  // null is "not resolved yet"; `loaded` is what separates that from "resolved, and there is no
  // such shift". Never cleared on a failed reload — the same policy History and the clock store
  // follow: a worker in a dead zone keeps the record they were reading.
  const [entry, setEntry] = useState<Entry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadGen = useRef(0);

  const [picking, setPicking] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignFailed, setAssignFailed] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<string | null>(null);

  const memberships = useSessionStore((s) => s.me?.memberships) ?? [];

  const load = useCallback(async () => {
    const mine = ++loadGen.current;
    try {
      const from = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
      const entries = await listEntries(from);
      if (mine !== loadGen.current) return;
      // Read after the await, not before: a flush or a hydrate can replace the open entry while
      // this request is in flight, and the fresher one is the one this screen should resolve to.
      const open = useClockStore.getState().openEntry;
      setEntry(findEntry(entries, open, id));
      setError(null);
    } catch (e) {
      if (mine !== loadGen.current) return;
      setError(e instanceof ApiError ? e.message : UNEXPECTED_ERROR);
    } finally {
      if (mine === loadGen.current) setLoaded(true);
    }
  }, [id]);

  // Once, not on every focus: this screen sits above the tabs and nothing navigates away and back
  // to it, so a focus effect would only re-fetch after the assign that already returned the answer.
  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setAssignFailed(null);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  // A membership can be revoked while its shift is still on file, so this may resolve to nothing.
  // null is passed straight into locationBadge, which words the sentence around a missing name
  // rather than printing one we do not have.
  const employerName =
    memberships.find((m) => m.employer.id === entry?.employer_id)?.employer
      .name ?? null;

  const assign = useCallback(
    async (m: Membership) => {
      setAssigning(true);
      setAssignFailed(null);
      try {
        const updated = await assignEmployer(id, m.employer.id);
        // Retires any load already in flight, the same generation guard load() uses against itself.
        // A pull-to-refresh started before this tap resolves *after* it — one full-window decrypt
        // against one tiny PATCH — and would otherwise overwrite the assigned entry with its
        // pre-assign snapshot, replacing a recorded `location_verified: false` with the vacuous
        // personal badge on the one screen whose premise is that its claims are true.
        loadGen.current++;
        setEntry(updated);
        setPicking(false);
        // The plan's "refetch → toast" collapses into this: PATCH answers with the assigned entry,
        // recomputed location_verified included (handler.go:572-579), so a refetch would spend a
        // second full-window decrypt to learn what the response already said. The History tab
        // reloads on its own focus effect, so going back is current too.
        const message = `Assigned to ${m.employer.name}. ${locationBadge(updated, m.employer.name).detail}`;
        setAssigned(message);
        announce(message);
      } catch (e) {
        // Deliberately not queued to the outbox. Its item kinds are clock-in | clock-out | pings —
        // a persisted, tested schema — and assign does not belong in them: PATCH /v1/entries/:id
        // carries no client_id (handler.go:530-535), so its only dedupe is the `employer_id: nil`
        // filter (store.go:117-120), and a replay of a request that landed but lost its response
        // answers 400 "entry already has an employer". retryable() (stores/outbox.ts:103) does not
        // retry a 400, so that item would surface as "could not be synced" for an action that in
        // fact succeeded. Nothing is lost by asking instead: the hours are already on record and
        // assignment has no deadline, unlike a clock-in, which is what the outbox exists for.
        const message =
          e instanceof ApiError
            ? assignError(e.code, e.message, m.employer.name)
            : UNEXPECTED_ERROR;
        setAssignFailed(message);
        announce(message);
      } finally {
        setAssigning(false);
      }
    },
    [id],
  );

  const body = () => {
    if (!loaded) {
      return (
        <ActivityIndicator
          accessibilityLabel="Loading shift"
          color={theme.brand}
          style={styles.loading}
        />
      );
    }
    if (entry) return <Record entry={entry} employerName={employerName} />;
    // A failed load must never render as "no such shift": that is a claim about the record, and
    // all we know is that we could not read it.
    if (error) return null;
    return (
      <Text style={styles.missing}>
        This shift isn’t in your last 30 days.
      </Text>
    );
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.brand}
        />
      }
    >
      {error != null && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          {/* An explicit retry: with nothing else on screen there is no scroll view tall enough
              to suggest it can be pulled. onRefresh rather than load(), so the retry borrows the
              RefreshControl's spinner — a bare load() leaves `loaded` true and shows nothing at
              all. `disabled` is what actually stops the repeat taps: the spinner is only feedback,
              and each tap is another 30-day server-side decrypt. */}
          <Pressable
            accessibilityRole="button"
            disabled={refreshing}
            onPress={onRefresh}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionLabel}>Try again</Text>
          </Pressable>
        </View>
      )}

      {body()}

      {/* Everything above is a record the worker cannot change. This is the only control on the
          screen, which is why it is separated by a rule rather than folded in among the facts. */}
      {entry && (
        <>
          <View style={styles.divider} />
          {assigned != null ? (
            <Text accessibilityLiveRegion="polite" style={styles.assigned}>
              {assigned}
            </Text>
          ) : entry.employer_id ? null : entry.status !== "closed" ? (
            // Surfaced rather than left to fail: the server refuses an open entry outright
            // (handler.go:559-561), because assigning would re-point the clock-out at the
            // employer's anchor and could strand the shift unclosable.
            <Text style={styles.note}>
              You can assign an employer once this shift is finished.
            </Text>
          ) : memberships.length === 0 ? (
            <Text style={styles.note}>
              You’re not a member of any employer yet, so there is nothing to
              assign this shift to.
            </Text>
          ) : (
            <View style={styles.assign}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Assign employer
              </Text>
              <Text style={styles.note}>
                Record this personal shift as worked for one of your employers.
                This can’t be undone.
              </Text>

              {/* The reveal is the confirmation step. No Alert.alert: it is a no-op on web and,
                  on a paused Android host, is stashed and never shown (lib/clockFlow.ts documents
                  the mechanism) — a dialog that may never appear is a poor guard for something
                  irreversible, whereas the warning above is on screen at the moment of the tap. */}
              {picking ? (
                memberships.map((m) => (
                  <Pressable
                    key={m.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Assign this shift to ${m.employer.name}`}
                    disabled={assigning}
                    onPress={() => void assign(m)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.rowLabel}>{m.employer.name}</Text>
                  </Pressable>
                ))
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setPicking(true)}
                  style={({ pressed }) => [
                    styles.action,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.actionLabel}>Assign employer</Text>
                </Pressable>
              )}

              {assigning && (
                <Text accessibilityLiveRegion="polite" style={styles.note}>
                  Assigning…
                </Text>
              )}
              {assignFailed != null && (
                <Text accessibilityLiveRegion="polite" style={styles.errorText}>
                  {assignFailed}
                </Text>
              )}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/**
 * The record half: times, duration, employer, the location verdict and any flags. Inert by
 * construction — nothing here is pressable, because nothing here is the worker's to change.
 */
function Record({
  entry,
  employerName,
}: {
  entry: Entry;
  employerName: string | null;
}) {
  const start = formatClock(entry.clock_in.at);
  // `clock_out`, not `status`: the server never writes one on an open entry, and this narrows.
  const end = entry.clock_out ? formatClock(entry.clock_out.at) : null;
  const duration = entry.clock_out
    ? formatDuration(
        (Date.parse(entry.clock_out.at) - Date.parse(entry.clock_in.at)) / 60000,
      )
    : null;
  const badge = locationBadge(entry, employerName);
  const notes = flagNotes(entry.flags);

  return (
    <View style={styles.record}>
      <Text accessibilityRole="header" style={styles.date}>
        {new Date(entry.clock_in.at).toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
        })}
      </Text>
      <Text style={styles.times}>{end ? `${start} – ${end}` : start}</Text>
      <Text style={styles.duration}>{duration ?? "Still on shift"}</Text>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Employer</Text>
        {/* "Employer" rather than "Personal" when the name will not resolve: a revoked membership
            leaves the shift booked to someone, and calling it personal is a claim about who owes
            the hours. Same rule as the History tab's chip. */}
        <Text style={styles.fieldValue}>
          {entry.employer_id ? (employerName ?? "Employer") : "Personal"}
        </Text>
      </View>

      <View style={styles.field}>
        {/* The tone is carried by the words first: `label` says verified or not, and the colour
            only agrees with it. Nothing on this screen is signalled by colour alone. */}
        <Text style={[styles.badgeLabel, styles[badge.tone]]}>
          {badge.label}
        </Text>
        <Text style={styles.fieldValue}>{badge.detail}</Text>
      </View>

      {notes.map((n) => (
        <View key={n.title} style={styles.field}>
          {/* Amber, never red: both flags are advisory (backend/internal/entry/model.go), neither
              is the worker's fault and neither is anything they can act on. */}
          <Text style={[styles.badgeLabel, styles.warn]}>{n.title}</Text>
          <Text style={styles.fieldValue}>{n.detail}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.surface },
  content: { padding: theme.spacing.l, gap: theme.spacing.m },
  loading: { padding: theme.spacing.l },
  missing: { color: theme.muted, fontSize: 16, lineHeight: 22 },
  record: { gap: theme.spacing.m },
  date: { color: theme.muted, fontSize: 14, fontWeight: "700" },
  times: { color: theme.text, fontSize: 28, fontWeight: "700" },
  duration: { color: theme.muted, fontSize: 16 },
  field: { gap: 2 },
  fieldLabel: {
    color: theme.muted,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  fieldValue: { color: theme.text, fontSize: 15, lineHeight: 21 },
  badgeLabel: { fontSize: 15, fontWeight: "700" },
  ok: { color: theme.ok },
  warn: { color: theme.warn },
  muted: { color: theme.muted },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.muted },
  assign: { gap: theme.spacing.s },
  sectionTitle: { color: theme.text, fontSize: 17, fontWeight: "700" },
  note: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  assigned: { color: theme.ok, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  // 48 pt targets, matching the clock and History screens' inline actions.
  row: { minHeight: 48, justifyContent: "center" },
  rowLabel: { color: theme.brand, fontSize: 17, fontWeight: "600" },
  action: { alignSelf: "flex-start", minHeight: 48, justifyContent: "center" },
  actionLabel: { color: theme.brand, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.6 },
  errorBox: { gap: theme.spacing.s / 2 },
  errorText: { color: theme.danger, fontSize: 14, lineHeight: 20 },
});
