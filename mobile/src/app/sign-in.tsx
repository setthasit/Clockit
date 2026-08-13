import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebAuthError, WebAuthErrorCodes, useAuth0 } from "react-native-auth0";

import { theme } from "@/lib/theme";
import { useSessionStore } from "@/stores/session";

// Both are spelled out rather than left to the SDK defaults (which are `openid profile email`
// and no audience): offline_access is what mints the refresh token every silent renew in
// stores/session.ts depends on, and with no audience Auth0 issues an opaque token that
// backend/internal/auth/jwt.go rejects on every request.
const SCOPE = "openid profile email offline_access";
const AUDIENCE = process.env.EXPO_PUBLIC_AUTH0_AUDIENCE;

export default function SignIn() {
  const { authorize, resumeSession } = useAuth0();
  const setToken = useSessionStore((s) => s.setToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Android may kill the app while Universal Login is open in the browser; the native SDK can
  // still finish the token exchange on restart, and this screen is exactly where such a relaunch
  // lands (no stored credentials yet, so the gate sends it here). Draining that here turns a
  // login the user already completed into a session instead of asking them to do it twice.
  // Resolves null on iOS (ios/A0Auth0.mm) and when there is nothing to recover, so it needs no
  // platform check; a failed recovery is not worth reporting — the button below still works.
  useEffect(() => {
    resumeSession().catch(() => {});
  }, [resumeSession]);

  const signIn = async () => {
    if (!AUDIENCE) {
      // EXPO_PUBLIC_* is inlined at build time, so this can never start working at runtime.
      // Saying so beats signing in successfully and having every API call 401 with no clue why.
      setError(
        "This build is missing EXPO_PUBLIC_AUTH0_AUDIENCE and cannot sign in.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Universal Login renders Google/Apple/Facebook/password itself — the app never sees a
      // credential. On success Auth0Provider stores the credentials and sets `user`, which is
      // what flips the gate in _layout.tsx; loading `me` and navigating are its job, not ours.
      const { accessToken } = await authorize({ audience: AUDIENCE, scope: SCOPE });
      setToken(accessToken);
    } catch (e) {
      // Never rendered or logged: an Auth0 error can carry session detail, and a cancel is the
      // user's own decision — re-showing the screen unchanged is the whole feedback it needs.
      if (e instanceof WebAuthError && e.type === WebAuthErrorCodes.USER_CANCELLED) return;
      setError("Sign in didn’t finish. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      {/* ponytail: a wordmark, because assets/ holds only Expo template art and shipping that as
          a logo would be worse than type. Swap in an <Image> when there is a real mark. */}
      <Text style={styles.wordmark}>ClockIt</Text>

      <View style={styles.actions}>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={signIn}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          {busy ? (
            <ActivityIndicator color={theme.brand} />
          ) : (
            <Text style={styles.buttonLabel}>Sign in</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.brand,
    padding: theme.spacing.l,
  },
  wordmark: {
    color: theme.surface,
    fontSize: 40,
    fontWeight: "700",
    letterSpacing: 1,
  },
  actions: { alignSelf: "stretch", marginTop: theme.spacing.l * 2 },
  error: {
    color: theme.surface,
    fontSize: 15,
    textAlign: "center",
    marginBottom: theme.spacing.m,
  },
  button: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.m,
    backgroundColor: theme.surface,
  },
  buttonLabel: { color: theme.brand, fontSize: 17, fontWeight: "600" },
  pressed: { opacity: 0.7 },
});
