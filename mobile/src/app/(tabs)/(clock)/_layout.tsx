import { Stack } from "expo-router";

// NativeTabs renders no headers, so each tab owns a native Stack for its UINavigationBar /
// Material toolbar. One screen per stack today; detail screens stay on the root Stack.
export default function ClockStack() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: "Clock" }} />
    </Stack>
  );
}
