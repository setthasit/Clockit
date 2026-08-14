// Advisory verdicts the backend puts on a shift. Shared by the calendar and the table so one
// flag cannot read as two different things in two views.
//
// Unknown values fall through as their wire name rather than disappearing: a flag the employer
// cannot see is worse than one that reads oddly, and a newer backend will ship one before this
// file learns about it.

const LABELS: Record<string, string> = {speed_anomaly: 'Speed anomaly'};

// What the flag actually claims — deliberately about the *measurement*, not about the worker.
// The backend never rejects on it (design §4.5), so neither does this copy.
const HINTS: Record<string, string> = {
  speed_anomaly: 'Movement between pings exceeded plausibility checks',
};

/** Chip text — two words, because that is all a chip holds. */
export function flagLabel(flag: string): string {
  return LABELS[flag] ?? flag;
}

/** What the chip means, for the line under it. Null for a flag this build has never heard of:
 *  its wire name is shown as the label, and inventing an explanation for it would be a guess. */
export function flagExplanation(flag: string): string | null {
  return HINTS[flag] ?? null;
}

/** Both together, for a tooltip that has no chip beside it to name the flag. */
export function flagHint(flag: string): string {
  const hint = flagExplanation(flag);
  return hint ? `${flagLabel(flag)}: ${hint}` : flagLabel(flag);
}
