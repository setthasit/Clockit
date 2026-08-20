import { Tabs } from "expo-router";
import { SymbolView } from "expo-symbols";

import { theme } from "@/lib/theme";

/**
 * Web keeps the JS tab bar: NativeTabs' web build is Radix top-tabs with no icons that
 * force-mounts every tab. Headers are off here because each tab's nested Stack renders its own.
 */
export function AppTabs() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.brandTint,
      }}
    >
      <Tabs.Screen
        name="(clock)"
        options={{
          title: "Clock",
          tabBarIcon: ({ color, size }) => (
            <SymbolView
              name={{ ios: "clock", android: "schedule" }}
              size={size}
              tintColor={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="(history)"
        options={{
          title: "History",
          tabBarIcon: ({ color, size }) => (
            <SymbolView
              name={{ ios: "clock.arrow.circlepath", android: "history" }}
              size={size}
              tintColor={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="(profile)"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => (
            <SymbolView
              name={{ ios: "person.crop.circle", android: "account_circle" }}
              size={size}
              tintColor={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
