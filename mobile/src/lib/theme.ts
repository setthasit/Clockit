export const theme = {
  brand: "#00286E",
  text: "#11181C",
  muted: "#687076",
  surface: "#FFFFFF",
  danger: "#B3261E",
  ok: "#1B7F4B",
  // "Needs looking at", never "broken": a dropped sync record, and 7.2's unverified-location
  // badge. Same value as the web app's light-mode --color-warning (web/src/clockit.css), so one
  // verdict reads the same amber to a worker and to their employer. Dark enough to pass AA on
  // `surface` (~6.4:1) — it is used for text, not only for a dot.
  warn: "#745B00",
  spacing: { s: 8, m: 16, l: 24 },
  radius: { m: 12, full: 999 },
};
