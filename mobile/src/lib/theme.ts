import {DynamicColorIOS, Platform, PlatformColor} from 'react-native';

import {palette} from './palette';

// if/else, not Platform.select: an object literal evaluates every branch eagerly, and RN's
// non-iOS DynamicColorIOS throws when called — Android would crash at module load.
const dynamic = (name: keyof typeof palette) => {
  if (Platform.OS === 'ios') return DynamicColorIOS(palette[name]);
  if (Platform.OS === 'android') return PlatformColor(`@color/clockit_${name.toLowerCase()}`);
  return palette[name].light; // web: light-only this phase
};

export const theme = {
  brand: palette.brand.light, // same in both schemes
  onBrand: palette.onBrand.light, // same in both schemes
  brandTint: dynamic('brandTint'),
  text: dynamic('text'),
  muted: dynamic('muted'),
  surface: dynamic('surface'),
  danger: dynamic('danger'),
  ok: dynamic('ok'),
  // "Needs looking at", never "broken": a dropped sync record, and 7.2's unverified-location
  // badge. Same value as the web app's light-mode --color-warning (web/src/clockit.css), so one
  // verdict reads the same amber to a worker and to their employer. Dark enough to pass AA on
  // `surface` (~6.4:1) — it is used for text, not only for a dot.
  // Dark pair lives in palette.ts; its contrast on dark `surface` is AA-checked in Task 5.
  warn: dynamic('warn'),
  spacing: {s: 8, m: 16, l: 24},
  radius: {m: 12, full: 999},
};
