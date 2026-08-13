import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ApiError } from "@/api/client";
import { type Entry, listEntries } from "@/api/entries";
import { EntryRow } from "@/components/EntryRow";
import { buildHistory } from "@/lib/history";
import { theme } from "@/lib/theme";
import { useClockStore } from "@/stores/clock";
import { useOutboxStore } from "@/stores/outbox";
import { useSessionStore } from "@/stores/session";

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

const UNEXPECTED_ERROR = "Something went wrong. Pull to refresh.";

export default function History() {
  // Its own fetch, not the clock store's: that store keeps two derived entries and throws the rest
  // away, and its list call is deliberately *unbounded* (an open entry has no age limit), which is
  // a cost its own ponytail note is scheduled to shrink to `status=open`. Subscribing this screen
  // to it would make that fix impossible. A window this narrow, read by one screen, is screen
  // state — a fifth store would only add a thing to invalidate.
  //
  // null means "not loaded yet", which is what separates the first spinner from a real empty
  // history. Never cleared on a failed reload: a worker in a dead zone keeps the list they had,
  // the same policy stores/clock.ts's hydrate follows.
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A pull and a focus reload can overlap, and the older answer must not win. Same ticket
  // mechanism as stores/clock.ts's writeGen, checked after the await.
  const loadGen = useRef(0);

  const memberships = useSessionStore((s) => s.me?.memberships);
  const openEntry = useClockStore((s) => s.openEntry);
  const needsAttention = useOutboxStore((s) => s.needsAttention);
  const clearAttention = useOutboxStore((s) => s.clearAttention);
  // The honest count of what has not reached the server, per stores/outbox.ts — not the clock
  // store's `pendingSince`, which is one global flag for a per-item queue and under-reports.
  const queued = useOutboxStore((s) => s.items.length);

  const load = useCallback(async () => {
    const mine = ++loadGen.current;
    try {
      const from = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
      const next = await listEntries(from);
      if (mine !== loadGen.current) return;
      setEntries(next);
      setError(null);
    } catch (e) {
      if (mine !== loadGen.current) return;
      // ApiError's messages are written for this audience (client.ts), including the offline one.
      setError(e instanceof ApiError ? e.message : UNEXPECTED_ERROR);
    }
  }, []);

  // Refetches on every focus *and* whenever the queue depth changes while this tab is up. Focus
  // covers coming back from a clock tap or, later, from 7.2's assign-employer. The `queued`
  // dependency covers the case focus cannot: task 9.1 flushing (or dropping) items while the
  // worker is already looking at this screen, after which the server has entries this list does
  // not. Every item leaves the queue by being accepted or dropped, so every flush that changed
  // anything changes this number — which is why **9.1 has to call nothing here**.
  //
  // Debounced because the number moves once per *item*, not once per flush: drain() removes
  // exactly one item per set, so a reconnect that clears a dozen queued actions would otherwise
  // fire a dozen back-to-back GET /v1/entries — each a 30-day window the server decrypts per
  // entry, on a route with no rate limiter, from the phone that just got signal back.
  //
  // ponytail: a blunt timer, so it also swallows the *enqueue* case — a clock-in tapped offline no
  // longer costs a fetch certain to fail whose error line sits under the banner already explaining
  // it — and the batching hole where a removal plus an enqueue coalesce into one unchanged length.
  // Ceiling: 300 ms of staleness after a real change, and a focus reload delayed by the same.
  // Upgrade path: hold the previous depth in a ref and reload only when it falls.
  useFocusEffect(
    useCallback(() => {
      const t = setTimeout(() => void load(), 300);
      return () => clearTimeout(t);
    }, [load, queued]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  // Pings never reach this screen: they are decoration, not hours (stores/outbox.ts), so a dropped
  // batch costs a polluted track and nothing a worker is owed — counting it under "could not be
  // synced" is a false alarm about pay. They also carry no entryClientId, so each would render as
  // its own line, and the one cascade that fills this list (a build stuck on CONFIG) drops up to
  // MAX_ATTENTION of them with an identical message. Filtered at the input rather than in
  // buildHistory, which owns the join, not the copy.
  const attention = useMemo(
    () => needsAttention.filter((a) => a.kind !== "pings"),
    [needsAttention],
  );

  const { sections, unmatched } = useMemo(
    () => buildHistory(entries ?? [], openEntry, attention),
    [entries, attention, openEntry],
  );

  // A membership can be revoked while its shift is still on file, so an id may resolve to nothing
  // — the shift is real either way and must never fall through to "Personal", which is a claim
  // about who is owed the hours. Same rule as the clock screen.
  const employerName = useCallback(
    (id: string | null) =>
      id
        ? (memberships?.find((m) => m.employer.id === id)?.employer.name ??
          "Employer")
        : null,
    [memberships],
  );

  const header = (
    <View style={styles.header}>
      {queued > 0 && (
        // Worth announcing: it appears and disappears on its own as the queue drains. Android
        // only — RN exposes no iOS equivalent (the clock screen's pill documents the same gap).
        <View accessibilityLiveRegion="polite" style={styles.banner}>
          <Text style={styles.bannerLabel}>
            {queued} {queued === 1 ? "action" : "actions"} waiting to sync
          </Text>
        </View>
      )}

      {attention.length > 0 && (
        <View style={styles.attention}>
          <Text style={styles.attentionTitle}>
            {attention.length === 1
              ? "1 action could not be synced"
              : `${attention.length} actions could not be synced`}
          </Text>
          {/* Records with no row of their own are rendered here or nowhere: a clock-out whose
              clock-in was dropped first names an entry the server never created. */}
          {unmatched.length > 0 ? (
            unmatched.map((a) => (
              <Text key={a.clientId} style={styles.attentionLine}>
                {a.message}
              </Text>
            ))
          ) : (
            <Text
              accessibilityLabel="Marked with a warning on the shifts below."
              style={styles.attentionLine}
            >
              ⚠ Marked on the shifts below.
            </Text>
          )}
          {/* The only caller of clearAttention in the app: these records are permanent otherwise,
              and nothing else can know the worker has read them. All-or-nothing by design — hence
              "all" in the label: an Attention record is the only surviving trace of a dropped
              item, and this one tap also wipes the ⚠ marks on rows further down, which the worker
              sitting under "Marked on the shifts below" has by definition not scrolled to yet. */}
          <Pressable
            accessibilityRole="button"
            onPress={clearAttention}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionLabel}>Dismiss all</Text>
          </Pressable>
        </View>
      )}

      {error != null && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          {/* An explicit retry, because when the list is empty there is nothing on screen to
              suggest it can be pulled. */}
          <Pressable
            accessibilityRole="button"
            onPress={() => void load()}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionLabel}>Try again</Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  // SectionList, not the plan's FlatList: the plan asks for day sections, and FlatList has none —
  // matching it literally would mean flattening headers into the data array and re-deriving them
  // in renderItem, for a component that ships sticky headers and takes the identical
  // refreshControl (both are VirtualizedList). Pull-to-refresh is unaffected.
  return (
    <SectionList
      sections={sections}
      keyExtractor={(row) => row.entry.client_id}
      renderItem={({ item }) => (
        <EntryRow
          entry={item.entry}
          employerName={employerName(item.entry.employer_id)}
          attention={item.attention}
        />
      )}
      renderSectionHeader={({ section }) => (
        // role=header is what lets a screen reader jump day to day instead of walking every row.
        <Text accessibilityRole="header" style={styles.day}>
          {section.title}
        </Text>
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={
        entries == null && error == null ? (
          <ActivityIndicator
            accessibilityLabel="Loading shifts"
            color={theme.brand}
            style={styles.loading}
          />
        ) : error != null ? (
          // The header already carries the message and the retry; a second "nothing here" under
          // it would read as "you have no shifts", which is a claim this screen cannot make.
          null
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No shifts in the last 30 days</Text>
            <Text style={styles.emptyHint}>
              Shifts you clock in and out of appear here.
            </Text>
          </View>
        )
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.brand}
        />
      }
      style={styles.screen}
    />
  );
}

const styles = StyleSheet.create({
  // No safe-area insets: this screen renders inside the tab navigator, which owns both edges.
  screen: { flex: 1, backgroundColor: theme.surface },
  header: { gap: theme.spacing.s, padding: theme.spacing.l, paddingBottom: 0 },
  banner: {
    backgroundColor: theme.brand,
    borderRadius: theme.radius.m,
    padding: theme.spacing.m,
  },
  bannerLabel: { color: theme.surface, fontSize: 15, fontWeight: "600" },
  attention: {
    borderWidth: 1,
    borderColor: theme.warn,
    borderRadius: theme.radius.m,
    padding: theme.spacing.m,
    gap: theme.spacing.s / 2,
  },
  attentionTitle: { color: theme.warn, fontSize: 15, fontWeight: "700" },
  attentionLine: { color: theme.text, fontSize: 14, lineHeight: 20 },
  errorBox: { gap: theme.spacing.s / 2 },
  errorText: { color: theme.danger, fontSize: 14, lineHeight: 20 },
  // 48 pt target, matching the clock screen's inline actions.
  action: {
    alignSelf: "flex-start",
    minHeight: 48,
    justifyContent: "center",
  },
  actionLabel: { color: theme.brand, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  day: {
    backgroundColor: theme.surface,
    color: theme.muted,
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: theme.spacing.l,
    paddingTop: theme.spacing.l,
    paddingBottom: theme.spacing.s,
    textTransform: "uppercase",
  },
  loading: { padding: theme.spacing.l },
  empty: { alignItems: "center", gap: theme.spacing.s, padding: theme.spacing.l },
  emptyTitle: { color: theme.text, fontSize: 17, fontWeight: "600" },
  emptyHint: { color: theme.muted, fontSize: 14, textAlign: "center" },
});
