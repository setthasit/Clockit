import { NativeTabs } from "expo-router/unstable-native-tabs";

import { theme } from "@/lib/theme";

/**
 * Real platform tab bars — UITabBar on iOS (liquid glass on 26+), Material 3 bottom navigation on
 * Android — instead of react-navigation's JS one. Children stay plain RN views, so this dodges the
 * @expo/ui accessibility gaps documented in app/clock-in.tsx entirely.
 *
 * A component, not the layout itself, because NativeTabs on web renders Radix top-tabs with no
 * icons and force-mounts every tab — AppTabs.web.tsx keeps the JS Tabs bar there.
 */
export function AppTabs() {
  return (
    <NativeTabs tintColor={theme.brandTint}>
      {/* The clock screen is a plain View, not a ScrollView, so iOS 18-and-earlier would draw the
          tab bar transparent over it without this. */}
      <NativeTabs.Trigger name="(clock)" disableTransparentOnScrollEdge>
        <NativeTabs.Trigger.Icon sf="clock" md="schedule" />
        <NativeTabs.Trigger.Label>Clock</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(history)">
        <NativeTabs.Trigger.Icon sf="clock.arrow.circlepath" md="history" />
        <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(profile)">
        <NativeTabs.Trigger.Icon sf="person.crop.circle" md="account_circle" />
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
