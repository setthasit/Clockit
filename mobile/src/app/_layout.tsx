import { Stack } from "expo-router";

// ponytail: bare stack — Auth0Provider and the session/permission gate land in task 2.
export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="permissions" options={{ title: "Location" }} />
      <Stack.Screen name="entry/[id]" options={{ title: "Shift" }} />
    </Stack>
  );
}
