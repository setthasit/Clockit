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
  // Auth0Provider builds its client *during render* (hooks/Auth0Provider.tsx:56) and the Auth0
  // constructor rejects an empty domain/clientId (core/utils/validation.ts), so a build missing
  // either env var would crash the root before any error UI exists. stores/session.ts made its own
  // client lazy for exactly this reason; the provider needs the guard instead.
  if (!auth0Config.domain || !auth0Config.clientId) {
    return (
      <View style={styles.screen}>
        <Text accessibilityRole="alert" style={styles.message}>
          This build is missing EXPO_PUBLIC_AUTH0_DOMAIN or
          EXPO_PUBLIC_AUTH0_CLIENT_ID and cannot sign in.
        </Text>
      </View>
    );
  }

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
 * The session flag is "credentials are still in the keychain", not `user`. Auth0Provider's
 * initialize() (hooks/Auth0Provider.tsx:97-109) only sets `user` after getCredentials(), which
 * *renews over the network* once the access token has expired — offline that renew throws and it
 * dispatches INITIALIZED with user:null, making a transport failure indistinguishable from having
 * no session. Since authorize() also needs network, a `!!user` gate would strand a worker at a
 * sign-in screen they cannot complete. hasValidCredentials() is a local keychain check
 * (canRenew() || hasValid(minTTL), ios/NativeBridge.swift:247-249), so it stays true offline and
 * turns false as soon as clearCredentials() wipes them — which is why `user` is in the effect's
 * deps: a 401-driven clear has to re-run the check. `user` is still OR'd in so a fresh login flips
 * the gate on the same tick.
 *
 * The store's accessToken is never the flag: it stays null until something calls the API.
 */
function Gate() {
  const { user, isLoading, clearCredentials, hasValidCredentials } = useAuth0();
  const me = useSessionStore((s) => s.me);
  const loadMe = useSessionStore((s) => s.loadMe);
  const [hasCreds, setHasCreds] = useState<boolean | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    // Waiting for isLoading keeps this off the mid-restore keychain state.
    if (isLoading) return;
    // `cancelled` is not cosmetic: without it a check started before clearCredentials() can
    // resolve `true` after one started later resolved `false`, leaving the gate stuck on a
    // session that no longer exists with nothing left to re-trigger it.
    let cancelled = false;
    hasValidCredentials()
      .then((ok) => !cancelled && setHasCreds(ok))
      .catch(() => !cancelled && setHasCreds(false));
    return () => {
      cancelled = true;
    };
  }, [isLoading, user, hasValidCredentials]);

  const signedIn = !!user || hasCreds === true;

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
          // hasCreds has to be invalidated by hand: when `user` was already null (a renew that
          // failed on launch), LOGOUT_COMPLETE changes nothing the keychain effect depends on, so
          // it never re-runs and the gate would sit on a spinner forever.
          clearCredentials()
            .then(() => setHasCreds(false))
            .catch(() => setMeError(e.message));
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

  // `!user && hasCreds === null` is the window where the keychain check is still in flight: without
  // it the gate would render sign-in for a frame before flipping back.
  if (
    isLoading ||
    (!user && hasCreds === null) ||
    (signedIn && !me && !meError)
  ) {
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
  // The re-seeded route is routeNames[0], and getSortedChildren (expo-router useScreens.js) keeps
  // declaration order: the FIRST <Stack.Screen> in each branch below is that branch's landing
  // route. Do not reorder them — moving "permissions" above "(tabs)" would land every sign-in on
  // the Location screen with no history entry to escape via.
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
