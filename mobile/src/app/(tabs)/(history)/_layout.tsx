import { Stack } from "expo-router";

// See (clock)/_layout.tsx for why each tab carries its own Stack. Large title is iOS-only and
// collapses as the SectionList scrolls; Android ignores it.
export default function HistoryStack() {
  return (
    <Stack>
      <Stack.Screen
        name="history"
        options={{ title: "History", headerLargeTitle: true }}
      />
    </Stack>
  );
}
