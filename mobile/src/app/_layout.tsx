import { Stack } from "expo-router";
import { Auth0Provider } from "react-native-auth0";

// Importing auth0Config also arms the api() auth handlers (stores/session.ts registers them at
// module scope), so no request can be issued before a token source exists.
import { auth0Config } from "@/stores/session";

// ponytail: no session/permission gate yet — screens are reachable unauthenticated until task 2.2.
export default function RootLayout() {
  return (
    <Auth0Provider {...auth0Config}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="permissions" options={{ title: "Location" }} />
        <Stack.Screen name="entry/[id]" options={{ title: "Shift" }} />
      </Stack>
    </Auth0Provider>
  );
}
