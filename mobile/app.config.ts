import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "ClockIt",
  slug: "clockit",
  version: "1.0.0",
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
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: "static",
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
