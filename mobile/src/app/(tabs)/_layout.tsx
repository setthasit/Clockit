import { SymbolView } from "expo-symbols";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { theme } from "@/lib/theme";

/**
 * One `StatusBar` per background colour, and never one at the root. Android's generated AppTheme
 * sets no `windowLightStatusBar`, which defaults to false — white icons, invisible over this
 * app's `theme.surface` screens (RN's WindowUtil only sets APPEARANCE_LIGHT_STATUS_BARS for
 * "dark-content"). iOS already renders dark content from `userInterfaceStyle: "light"`, so there
 * this is a no-op that keeps the two platforms saying the same thing.
 *
 * Root-level would be wrong, not merely redundant: RN's StatusBar applies the LAST-MOUNTED entry
 * of a props stack, and componentDidMount runs child-first — so a root instance is pushed after
 * every screen's and overrides all of them, including the brand-blue ones that need "light".
 *
 * This one covers the whole tab navigator and stays mounted under `entry/[id]` and a pushed
 * `permissions`, both of which are `theme.surface` too.
 */
export default function TabsLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Tabs screenOptions={{ tabBarActiveTintColor: theme.brand }}>
        <Tabs.Screen
          name="index"
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
          name="history"
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
          name="profile"
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
    </>
  );
}
