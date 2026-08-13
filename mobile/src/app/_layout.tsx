import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Auth0Provider, useAuth0 } from "react-native-auth0";

import { ApiError } from "@/api/client";
import { theme } from "@/lib/theme";
// Importing auth0Config also arms the api() auth handlers (stores/session.ts registers them at
// module scope), so no request can be issued before a token source exists.
import { auth0Config, useSessionStore } from "@/stores/session";

export default function RootLayout() {
  return (
    <Auth0Provider {...auth0Config}>
      <Gate />
    </Auth0Provider>
  );
}

/**
 * Decides what a launch lands on. Its own component because useAuth0() only reads a provider
 * mounted above it.
 *
 * `user` — not the store's accessToken — is the session flag: Auth0Provider restores credentials
 * itself at mount (hooks/Auth0Provider.tsx initialize()) and reports that through isLoading/user,
 * while accessToken stays null until something actually calls the API.
 */
function Gate() {
  const { user, isLoading, clearCredentials } = useAuth0();
  const me = useSessionStore((s) => s.me);
  const loadMe = useSessionStore((s) => s.loadMe);
  const [meError, setMeError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  const signedIn = !!user;

  // `me` is loaded here rather than per screen so every screen below can assume it: memberships
  // drive the clock, history and profile tabs alike, and one loader means one retry path.
  useEffect(() => {
    // `me` is a dependency deliberately: onUnauthorized() clears it mid-session, and the gate has
    // to notice and re-resolve rather than sit on a spinner. The ref is what keeps that from
    // becoming a second concurrent fetch (and dedupes the double effect invocation in dev).
    if (!signedIn || me || inFlight.current) return;
    inFlight.current = true;
    setMeError(null);
    loadMe()
      .catch((e: unknown) => {
        // `e` is never logged: api() puts server copy in the message, and an Auth0-sourced
        // failure can carry session detail.
        if (e instanceof ApiError && e.status === 401) {
          // The stored credentials cannot be renewed (revoked or expired refresh token). api()
          // already dropped the local session, but Auth0 still holds the dead credentials, so
          // `user` stays set and every retry would 401 again. Dropping them locally flips this
          // gate to sign-in. Not clearSession() — the federated logout is task 8.1's.
          clearCredentials().catch(() => setMeError(e.message));
          return;
        }
        // Everything else keeps the session: an offline launch is not a signed-out user, and a
        // backend outage must not wipe credentials for everyone who opens the app during it.
        setMeError(
          e instanceof ApiError ? e.message : "Something went wrong.",
        );
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [signedIn, me, attempt, loadMe, clearCredentials]);

  if (isLoading || (signedIn && !me && !meError)) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={theme.surface} />
      </View>
    );
  }

  if (signedIn && !me) {
    return (
      <View style={styles.screen}>
        <Text accessibilityRole="alert" style={styles.message}>
          {meError}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setAttempt((n) => n + 1)}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryLabel}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  // Stack.Protected removes screens from the navigator instead of navigating away from them:
  // StackRouter.getStateForRouteNamesChange drops every route whose name is no longer registered
  // and re-seeds the stack with routeNames[0], so the screens on the wrong side of the guard leave
  // no history entry to swipe back into — a router.replace() cannot promise that as strongly.
  // Exactly one branch is ever non-empty, so the re-seeded route is never ambiguous.
  //
  // ponytail: auth half only. Task 4.2 adds the location branch here (session but the explainer
  // was never seen → /permissions); it needs 4.2's persisted "explainer seen" flag, because a user
  // who tapped "Not now" leaves the OS permission undetermined and a gate keyed on that alone
  // would redirect them forever.
  return (
    <Stack>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="permissions" options={{ title: "Location" }} />
        <Stack.Screen name="entry/[id]" options={{ title: "Shift" }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

// Brand blue matches the splash screen's backgroundColor (app.config.ts), so the handover from
// the native splash to this gate has no flash of another colour.
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.brand,
    padding: theme.spacing.l,
  },
  message: {
    color: theme.surface,
    fontSize: 16,
    textAlign: "center",
    marginBottom: theme.spacing.m,
  },
  retry: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.l,
    borderRadius: theme.radius.m,
    backgroundColor: theme.surface,
  },
  retryLabel: { color: theme.brand, fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.7 },
});
