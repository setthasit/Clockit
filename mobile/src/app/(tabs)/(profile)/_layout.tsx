import { Stack } from "expo-router";

// See (clock)/_layout.tsx for why each tab carries its own Stack.
export default function ProfileStack() {
  return (
    <Stack>
      <Stack.Screen
        name="profile"
        options={{ title: "Profile", headerLargeTitle: true }}
      />
    </Stack>
  );
}
