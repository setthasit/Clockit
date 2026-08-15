import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "ClockIt",
  slug: "clockit",
  version: "1.0.0",
  // EAS Update keys off this, and `appVersionSource: "remote"` in eas.json rules out the
  // "nativeVersion" policy. The EAS project does not exist yet — after `eas init` +
  // `eas update:configure`, add `extra: { eas: { projectId: "<uuid>" } }` and
  // `updates: { url: "https://u.expo.dev/<uuid>" }` here (EAS CLI cannot write a TS config).
  runtimeVersion: { policy: "appVersion" },
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: "clockit",
  // theme.ts is a single light palette, so dark native chrome would clash.
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "ai.duckos.clockit",
    icon: "./assets/expo.icon",
  },
  android: {
    package: "ai.duckos.clockit",
    // Required by expo-task-manager, which neither it nor the expo-location plugin declares:
    // TaskManagerUtils schedules the job that delivers a background location batch with
    // setPersisted(true), and Android rejects a persisted job from an app without this
    // permission — `IllegalArgumentException: Requested job cannot be persisted without holding
    // android.permission.RECEIVE_BOOT_COMPLETED`, thrown on the main thread inside the delivery
    // broadcast, i.e. a hard crash on the first on-shift ping rather than a dropped one. Verified
    // on a Pixel 10 Pro emulator (API 37). expo-task-manager's own manifest already registers a
    // receiver for BOOT_COMPLETED, so holding it is what the library expects, not an extra ask.
    permissions: ["android.permission.RECEIVE_BOOT_COMPLETED"],
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  // "single", not "static": static rendering prerenders every route through Node at build time,
  // and this app is entirely behind an Auth0 session with a persisted store that touches `window`
  // — so the prerender pass has nothing to produce and dies on `window is not defined`. The web
  // target has never built with `output: "static"`; it exports cleanly as a single-page bundle.
  web: {
    output: "single",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#00286E",
        image: "./assets/images/splash-icon.png",
        imageWidth: 76,
      },
    ],
    // Undefined domain is tolerated so config evaluation works without a .env;
    // the native build is what actually needs it.
    ["react-native-auth0", { domain: process.env.EXPO_PUBLIC_AUTH0_DOMAIN }],
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "ClockIt uses your location when you clock in or out to confirm you are at your workplace.",
        locationAlwaysAndWhenInUsePermission:
          "ClockIt records your location during an active shift, from clock-in until clock-out, so your employer can verify hours worked. It never tracks you off shift.",
        locationAlwaysPermission:
          "ClockIt records your location during an active shift, from clock-in until clock-out, so your employer can verify hours worked. It never tracks you off shift.",
        // ClockIt never calls the motion activity APIs; false deletes the key the plugin adds by default.
        motionUsagePermission: false,
        // Background keys land now so phase 5 (on-shift pings) needs no new native build.
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
