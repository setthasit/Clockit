import * as Location from "expo-location";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
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
// Side-effect import, and load-bearing: it registers the background location task with
// TaskManager and arms the clock-store subscription that starts and stops it. Nothing here uses
// a value from it, so an "unused import" cleanup would silently disable on-shift pings.
import "@/location/tracking";
import { startSync } from "@/lib/sync";
import { theme } from "@/lib/theme";
import { useClockStore } from "@/stores/clock";
// Importing auth0Config also arms the api() auth handlers (stores/session.ts registers them at
// module scope), so no request can be issued before a token source exists.
import { auth0Config, useSessionStore } from "@/stores/session";
import { useUiStore } from "@/stores/ui";
import Permissions from "./permissions";

export default function RootLayout() {
  // Auth0Provider builds its client *during render* (hooks/Auth0Provider.tsx:56) and the Auth0
  // constructor rejects an empty domain/clientId (core/utils/validation.ts), so a build missing
  // either env var would crash the root before any error UI exists. stores/session.ts made its own
  // client lazy for exactly this reason; the provider needs the guard instead.
  if (!auth0Config.domain || !auth0Config.clientId) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
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
  // Reads the OS status on mount (createPermissionHook's `get` defaults to true) and stays null
  // until that resolves. It never *requests* — only the button on the explainer does.
  // It is a launch-time snapshot and nothing else: permissions.tsx calls the *module* function
  // rather than this hook's requester, so the hook's setStatus never fires, and there is no
  // foreground listener re-reading it. Harmless today because `explainerSeen` is what un-gates —
  // anything that starts branching on a *fresh* status here needs its own read.
  const [permission] = Location.useForegroundPermissions();
  const uiHydrated = useUiStore((s) => s.hydrated);
  const explainerSeen = useUiStore((s) => s.locationExplainerSeen);
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
          //
          // reset() because this is the *other* way out of a session, and useClockStore is module
          // scope: it survives the gate flip, the sign-in screen and the next sign-in. Without it
          // the next worker on a shared phone renders the previous one's open shift — and its
          // coordinates — from mount until a GET /v1/entries lands, which offline is never
          // (stores/clock.ts never clears state on a failed hydrate). Only the clock store: the
          // outbox must survive a 401 (`retryable` returns true for it) so the *same* worker's
          // unsent hours are recoverable. Clock state is server-authoritative; queued hours are not.
          clearCredentials()
            .then(() => {
              useClockStore.getState().reset();
              setHasCreds(false);
            })
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

  // The outbox's flush triggers (lib/sync.ts). Here rather than on a screen because a queued shift
  // must sync whichever tab is up.
  //
  // Keyed on `signedIn`, NOT on `me`. `me` is a profile fetch, not a session check, and the two
  // come apart in exactly the case these triggers exist for: an offline relaunch with a queued
  // shift (the worker force-quits, or the OS evicts the app mid-shift in a dead zone) keeps
  // `signedIn` true — hasValidCredentials() is a local keychain read — while loadMe() throws
  // NETWORK and the gate lands on the Retry screen below with `me` null forever. Gating on `me`
  // armed no listener there: signal returning did nothing, foregrounding did nothing, and the
  // queue moved only if the worker happened to tap Retry, all while the server's MAX_QUEUED_AGE
  // was running down. `signedIn` is the session, which is what the cleanup is protecting against
  // outliving; a launch flush against a dead session costs one 401 the queue survives by design
  // (stores/outbox.ts), and the gate's own loadMe 401 ends that session anyway. It also keeps a
  // mid-session 401 from tearing the listeners down and re-arming them.
  useEffect(() => {
    if (!signedIn) return;
    return startSync();
  }, [signedIn]);

  // `styles.screen` is brand blue, so these two carry their own StatusBar. Deliberately here and
  // not once around the whole component: RN applies the LAST-MOUNTED entry of a props stack and
  // componentDidMount runs child-first, so a single instance wrapping the returns below would be
  // pushed after every screen's and override all of them — including (tabs)', whose light
  // backgrounds are the reason any of this exists.
  const spinner = (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ActivityIndicator color={theme.surface} />
    </View>
  );

  // `!user && hasCreds === null` is the window where the keychain check is still in flight: without
  // it the gate would render sign-in for a frame before flipping back.
  if (
    isLoading ||
    (!user && hasCreds === null) ||
    (signedIn && !me && !meError)
  ) {
    return spinner;
  }

  if (signedIn && !me) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
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

  // Rehydration is async and `explainerSeen` reads false until it lands, so deciding early would
  // flash the explainer at someone who dismissed it three months ago. ui.ts sets `hydrated` on the
  // error path too, so this cannot hang. Kept as its own check rather than folded into the spinner
  // above so a failed /me still reaches the Retry screen instead of hanging here.
  if (signedIn && !uiHydrated) {
    return spinner;
  }

  // Only a user who has never seen the explainer waits on the OS read; everyone else is past this
  // gate on `explainerSeen` alone and never blocks on a permission call again.
  //
  // ponytail: usePermission has no error channel (expo-modules-core PermissionsHook.ts: the
  // getMethod promise is unguarded, so a rejection leaves `permission` null forever), which on web
  // or a dev build without the native module leaves a first-launch user on this spinner with no
  // Retry. Ceiling: that one cohort. Upgrade path: read the status here with a plain
  // getForegroundPermissionsAsync().catch() and treat a failure as UNDETERMINED.
  if (signedIn && !explainerSeen && !permission) {
    return spinner;
  }

  // The location half of the gate. Rendered directly rather than routed to, for the same reason
  // the spinner and Retry screens above are: it sidesteps the declaration-order hazard documented
  // below entirely, needs no navigator to exist yet, and leaves no history entry to swipe back
  // into. Once the flag flips, this component simply stops being returned and the Stack mounts on
  // its first screen, (tabs). /permissions stays a normal registered route, so task 8.1's profile
  // screen can still link to it.
  //
  // UNDETERMINED is the only status worth interrupting a launch for: it is the one state where the
  // OS will actually show a prompt. `granted` needs no pitch, and `denied` cannot be re-prompted
  // from here at all — that user needs the Settings deep link the clock screen owns (task 6.1), so
  // canAskAgain adds nothing to this condition. `explainerSeen` is what stops the loop: "Not now"
  // leaves the status UNDETERMINED forever.
  if (
    signedIn &&
    permission?.status === Location.PermissionStatus.UNDETERMINED &&
    !explainerSeen
  ) {
    return <Permissions />;
  }

  // Stack.Protected removes screens from the navigator instead of navigating away from them:
  // StackRouter.getStateForRouteNamesChange drops every route whose name is no longer registered
  // and re-seeds the stack with routeNames[0], so the screens on the wrong side of the guard leave
  // no history entry to swipe back into — a router.replace() cannot promise that as strongly.
  // The re-seeded route is routeNames[0], and getSortedChildren (expo-router useScreens.js) keeps
  // declaration order: the FIRST <Stack.Screen> in each branch below is that branch's landing
  // route. Do not reorder them — moving "permissions" above "(tabs)" would land every sign-in on
  // the Location screen with no history entry to escape via. The location branch above deliberately
  // does not touch this block for that reason.
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
