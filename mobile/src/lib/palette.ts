/** Hand-picked pairs. Light column IS the shipped light theme — do not "improve" it here. */
export const palette = {
  brand:      { light: "#00286E", dark: "#00286E" }, // fill: brand identity, never tinted
  brandTint:  { light: "#00286E", dark: "#7DA5F5" }, // brand as text/icon on surface
  onBrand:    { light: "#FFFFFF", dark: "#FFFFFF" },
  text:       { light: "#11181C", dark: "#ECEDEE" },
  muted:      { light: "#687076", dark: "#9BA1A6" },
  surface:    { light: "#FFFFFF", dark: "#151718" },
  danger:     { light: "#B3261E", dark: "#F2B8B5" },
  ok:         { light: "#1B7F4B", dark: "#4CBB7F" },
  warn:       { light: "#745B00", dark: "#E0C24A" },
} as const;
