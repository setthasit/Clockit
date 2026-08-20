import {
  AndroidConfig,
  type ConfigPlugin,
  withAndroidColors,
  withAndroidColorsNight,
} from "expo/config-plugins";
// Explicit .ts extension: Expo transpiles only the plugin entry file; this nested import goes
// through plain Node require, where Node 24 type stripping resolves only explicit-.ts specifiers.
import { palette } from "../src/lib/palette.ts";

const assignAll = (
  resources: AndroidConfig.Resources.ResourceXML,
  side: "light" | "dark",
) => {
  for (const [name, pair] of Object.entries(palette))
    resources = AndroidConfig.Colors.assignColorValue(resources, {
      name: `clockit_${name.toLowerCase()}`,
      value: pair[side],
    });
  return resources;
};

const withNativeColors: ConfigPlugin = (config) => {
  config = withAndroidColors(config, (c) => {
    c.modResults = assignAll(c.modResults, "light");
    return c;
  });
  return withAndroidColorsNight(config, (c) => {
    c.modResults = assignAll(c.modResults, "dark");
    return c;
  });
};

export default withNativeColors;
