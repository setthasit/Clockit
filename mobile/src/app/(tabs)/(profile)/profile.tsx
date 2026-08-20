import Constants from "expo-constants";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth0 } from "react-native-auth0";

import { ApiError } from "@/api/client";
import { patchMe } from "@/api/me";
import { signOut } from "@/lib/signOut";
import { theme } from "@/lib/theme";
import { useOutboxStore } from "@/stores/outbox";
import { useSessionStore } from "@/stores/session";

const UNEXPECTED_ERROR = "Something went wrong. Please try again.";

// Only codes whose own text is not showable, the same rule lib/entryDetail.ts states. Kept
// separate from that file's ASSIGN_COPY and from lib/clockFlow.ts's COPY, which share no key with
// this route: those answer verdicts about a *location fix* or about an entry's state, while
// PATCH /v1/me can only answer about a string. Everything absent falls through to `e.message` —
// client.ts's offline and session copy is written for this audience.
const SAVE_COPY: Record<string, string> = {
  // The server's own words are "name must not be empty" (user/handler.go). Unreachable, because
  // the trim below refuses to send one — this is the second lock, not the first.
  INVALID_ARGUMENT: "Your name can’t be empty.",
  // httpx renders these two as "too many requests" and, for any non-AppError, the bare string
  // "internal error" (httpx/errors.go) — developer copy either way.
  RATE_LIMITED: "Too many requests just now. Wait a moment and try again.",
  INTERNAL: "Something went wrong on the server. Try again in a moment.",
  // api()'s truncated 200 as well as its unparseable body (client.ts), so the save may well have
  // landed; the fall-through would say "The server returned a malformed response." on top of that.
  UNKNOWN: "Couldn’t read the server’s reply. Check your name below before saving again.",
};

/**
 * Account, employers, and the way out.
 *
 * Plain RN + StyleSheet, not the plan's `@expo/ui/universal` `FieldGroup`/`List`/`TextInput`. Those
 * three do exist in 57.0.10 (under the package's `.` export; there is still no `universal`
 * specifier, as 6.3 found), and a settings form is exactly what `FieldGroup` is for — but across
 * the whole universal surface `accessibilityLabel` is declared on exactly one component, `Icon`.
 * `UniversalBaseProps` has none, `ListItemProps` has none, `TextInputProps` has none, and Android's
 * `ModifierRegistry` still registers no `contentDescription` (its `semantics` modifier sets autofill
 * `contentType` only). There is also no progress indicator in the set. So the three things this
 * screen must say out loud — a rejected save, a save in flight, and "signing out will destroy N
 * unsynced actions" — have no carrier, and the RN escape hatch means an `RNHostView` per message.
 * That is §7.1's "fighting it".
 */
export default function Profile() {
  const { clearSession, clearCredentials } = useAuth0();
  const me = useSessionStore((s) => s.me);
  const setProfile = useSessionStore((s) => s.setProfile);
  const loadMe = useSessionStore((s) => s.loadMe);
  const [refreshing, setRefreshing] = useState(false);
  // The honest count of writes no server has seen, straight from the queue that owns them.
  const queued = useOutboxStore((s) => s.items.length);

  const [draft, setDraft] = useState(() => me?.user.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutInFlight = useRef(false);

  // The gate loads `me` before it mounts the tabs (app/_layout.tsx), so this is unreachable in
  // practice — but it is also the exact moment a sign-out passes through, and rendering someone
  // else's name for one frame is not worth a non-null assertion.
  if (!me) return null;

  const name = me.user.name;
  const dirty = draft !== name;

  // The only way memberships update after launch: the backend claims invitations on every
  // GET /v1/me, but the gate loads `me` once. Failure is silent — the spinner stops and the
  // stale-but-valid data stays, the same call loadMe() itself makes at launch.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadMe();
    } catch {
      // ponytail: no error banner; a failed pull just ends. Add copy if workers report confusion.
    } finally {
      setRefreshing(false);
    }
  };

  const save = async () => {
    const next = draft.trim();
    if (!next) {
      // Refused here rather than sent: the server answers a 400, and a worker should not learn
      // the rule from a rejection when the field is right in front of them.
      setSaveError("Your name can’t be empty.");
      return;
    }
    if (next === name) {
      // Whitespace-only edit. Normalise the field and send nothing.
      setDraft(next);
      setSaveError(null);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      // Not optimistic, and deliberately never queued to the outbox: that queue's item kinds are
      // clock-in | clock-out | pings, a persisted and tested schema, and it exists because hours
      // are money and have a deadline. A name has neither — showing a change that did not happen
      // is worse than asking again when there is signal, and PATCH /v1/me carries no client_id to
      // dedupe a replay with anyway.
      const user = await patchMe({ name: next });
      setProfile(user);
      // From the response, not from `next`: the server trims, and this is what it stored.
      setDraft(user.name);
    } catch (e) {
      setSaveError(
        e instanceof ApiError
          ? (SAVE_COPY[e.code] ?? e.message)
          : UNEXPECTED_ERROR,
      );
    } finally {
      setSaving(false);
    }
  };

  const runSignOut = async () => {
    // The actual guard, the same idiom and the same reason as the clock screen's: `disabled` lands
    // a render late, so two taps in one JS tick both read `signingOut === false`. The second
    // clearSession() rejects TRANSACTION_ACTIVE_ALREADY — not USER_CANCELLED — and falls through to
    // clearCredentials(), wiping local state while the first browser logout is still open and still
    // refusable. That is exactly the cancel-safety lib/signOut.ts is ordered to protect.
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await signOut({ clearSession, clearCredentials });
      // Nothing is set on success: the wipe clears `me`, the gate re-renders on it and this screen
      // unmounts. A cancel keeps the confirmation open with no message — the choice is not lost,
      // and backing out of a browser dialog needs no explanation.
      if (!result.done) {
        setSignOutError(result.message);
        setSigningOut(false);
      }
    } finally {
      signOutInFlight.current = false;
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={theme.brandTint}
          colors={[theme.brandTint]}
        />
      }
    >
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Your details
        </Text>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            accessibilityLabel="Your name"
            value={draft}
            onChangeText={setDraft}
            editable={!saving}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={styles.input}
          />
        </View>

        {/* Only while there is something to save, so the row is never a control that does nothing.
            Revert sits beside it because the field is the only thing on this screen a mistyped tap
            can change, and there is otherwise no way back to the stored value. */}
        {dirty && (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: saving, disabled: saving }}
              disabled={saving}
              onPress={() => void save()}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              {saving ? (
                <ActivityIndicator
                  accessibilityLabel="Saving your name"
                  color={theme.brandTint}
                />
              ) : (
                <Text style={styles.actionLabel}>Save</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={() => {
                setDraft(name);
                setSaveError(null);
              }}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Text style={styles.actionLabel}>Revert</Text>
            </Pressable>
          </View>
        )}

        {/* Android only — RN exposes no iOS equivalent, the gap the History banner and the clock
            pill both accept. Tolerable here because the field keeps focus and the message appears
            directly under it, unlike 7.2's assign, whose button unmounts under VoiceOver. */}
        {saveError != null && (
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            {saveError}
          </Text>
        )}

        {/* Hidden rather than shown empty: an identity can reach the backend with no email (the
            claim comes from an Auth0 Action), and a labelled field with nothing under it reads as
            a failure to load rather than as an account that has no address. */}
        {me.user.email !== "" && (
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Email</Text>
            {/* Read-only: the email is the Auth0 identity the backend keys the account on, so it
                is not this app's to change. No phone row at all — /v1/me returns `has_phone`,
                never the number (api/me.ts), and there is no way to clear one in v1 either. */}
            <Text style={styles.fieldValue}>{me.user.email}</Text>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Employers
        </Text>
        {me.memberships.length === 0 ? (
          <Text style={styles.note}>
            You’re not a member of any employer yet. Shifts you record are
            personal until one adds you. Pull down to check again after your
            employer adds your email.
          </Text>
        ) : (
          me.memberships.map((m) => (
            // "Added by", because membership is the employer's act, not the worker's — there is no
            // route here to leave one. `m.status` rather than the literal "active": /v1/me returns
            // active memberships only today, and printing the field keeps this honest on the day
            // api/me.ts widens it.
            <Text key={m.id} style={styles.fieldValue}>
              Added by {m.employer.name} · {m.status}
            </Text>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          About
        </Text>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Version</Text>
          {/* expoConfig, not the deprecated `nativeAppVersion` (which now points at
              expo-application, a dependency this app does not have). It is populated from the
              embedded manifest in a release build and from the dev server in development, and it
              tracks the JS bundle rather than the binary — which is the half that an update can
              change under a worker. */}
          <Text style={styles.fieldValue}>
            {Constants.expoConfig?.version ?? "unknown"}
          </Text>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.section}>
        {/* On screen before any tap, never revealed by one. This is the sentence that decides
            whether the worker should sign out at all, and stores/outbox.ts is explicit that
            clearing the queue destroys captured hours no server has seen. Phase 3 ships no flush
            trigger (task 9.1 owns them), so today these actions cannot be rescued from here. */}
        {queued > 0 && (
          <Text style={styles.warnText}>
            {queued === 1
              ? "1 unsynced action will be lost if you sign out."
              : `${queued} unsynced actions will be lost if you sign out.`}
          </Text>
        )}

        {/* The reveal *is* the confirmation, and only where there is something to lose. No
            Alert.alert: it is a no-op on web and, on a paused Android host, is stashed and never
            shown (lib/clockFlow.ts documents the mechanism), so a dialog that may never appear is
            a poor guard for something irreversible — the same call 7.2's assign made. */}
        {confirming ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              // Spelled out rather than left to the child text: the warning above is a separate
              // node, so a screen reader landing on this button alone would otherwise hear only
              // "Sign out anyway" with no anyway.
              accessibilityLabel={
                queued > 0
                  ? `Sign out anyway. ${queued} unsynced ${queued === 1 ? "action" : "actions"} will be lost.`
                  : "Sign out anyway"
              }
              accessibilityState={{ busy: signingOut, disabled: signingOut }}
              disabled={signingOut}
              onPress={() => void runSignOut()}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              {signingOut ? (
                <ActivityIndicator
                  accessibilityLabel="Signing out"
                  color={theme.danger}
                />
              ) : (
                <Text style={styles.dangerLabel}>Sign out anyway</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={signingOut}
              onPress={() => {
                setConfirming(false);
                setSignOutError(null);
              }}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <Text style={styles.actionLabel}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: signingOut, disabled: signingOut }}
            disabled={signingOut}
            // Always confirms, never straight through on `queued === 0`. That branch read the
            // count, and the count is 0 while the outbox rehydrate is still in flight — so the one
            // moment it could skip the warning is a moment it cannot know there is nothing to warn
            // about. stores/outbox.ts calls warn-or-flush a correctness rule, and the cost of
            // honouring it unconditionally is one tap on a queue that was empty anyway. The reveal
            // also re-reads `queued` on the second tap, by which time the rehydrate has landed.
            onPress={() => setConfirming(true)}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            {signingOut ? (
              <ActivityIndicator
                accessibilityLabel="Signing out"
                color={theme.danger}
              />
            ) : (
              <Text style={styles.dangerLabel}>Sign out</Text>
            )}
          </Pressable>
        )}

        {signOutError != null && (
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            {signOutError}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // No safe-area insets: this screen renders inside the tab navigator, which owns both edges.
  screen: { flex: 1, backgroundColor: theme.surface },
  content: { padding: theme.spacing.l, gap: theme.spacing.l },
  section: { gap: theme.spacing.s },
  sectionTitle: { color: theme.text, fontSize: 17, fontWeight: "700" },
  field: { gap: 2 },
  fieldLabel: {
    color: theme.muted,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  fieldValue: { color: theme.text, fontSize: 15, lineHeight: 21 },
  // 48 pt before the text does anything, matching every other tappable row in the app.
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: theme.muted,
    borderRadius: theme.radius.m,
    paddingHorizontal: theme.spacing.m,
    color: theme.text,
    fontSize: 17,
  },
  actions: { flexDirection: "row", gap: theme.spacing.l },
  // minWidth as well as minHeight: alignSelf shrinks the row to the text, and "Save" is ~35 pt
  // wide — under the 44 pt minimum in both platforms' guidance, with no horizontal padding here to
  // make it up.
  action: {
    alignSelf: "flex-start",
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
  },
  actionLabel: { color: theme.brandTint, fontSize: 16, fontWeight: "600" },
  dangerLabel: { color: theme.danger, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.6 },
  note: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  // Amber, not red: nothing has gone wrong yet, and this is the one line that can stop it.
  warnText: { color: theme.warn, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  errorText: { color: theme.danger, fontSize: 14, lineHeight: 20 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.muted },
});
