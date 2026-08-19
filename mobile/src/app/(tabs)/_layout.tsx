import { StatusBar } from "expo-status-bar";

import { AppTabs } from "@/components/AppTabs";

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
 *
 * The tab bar itself lives in AppTabs — native tabs on iOS/Android, the JS bar on web
 * (AppTabs.web.tsx). Platform split via component, not `_layout.web.tsx`: Expo Router does not
 * support platform extensions for route files.
 */
export default function TabsLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <AppTabs />
    </>
  );
}
