import type {Entry} from '@/api/entries';
import {dayKey} from '@/lib/format';
import type {Attention} from '@/stores/outbox';

/**
 * What the History screen draws, computed from three sources it does not own: the fetched window,
 * the clock store's open entry and the outbox's dropped records.
 *
 * A plain module rather than a `useMemo` in the screen, for the same reason clockFlow.ts is not a
 * handler: the join below is the only thing that tells a worker their shift was *refused*, it is
 * wrong in a way that fails silently (a matched-on-the-wrong-key record simply never lights an
 * icon), and there is no renderer in this repo to reach it through the component. The screen keeps
 * what only a screen can have — the fetch, the refresh state, the layout.
 *
 * Type-only imports throughout: this file is driven by a test in bare Node, and a value import of
 * stores/outbox would drag zustand and AsyncStorage in behind it.
 */

export type HistoryRow = {
  entry: Entry;
  /** Records the outbox dropped for this entry. Usually empty, at most one in practice. */
  attention: Attention[];
};

export type DaySection = {key: string; title: string; data: HistoryRow[]};

export type History = {
  sections: DaySection[];
  /** Dropped records with no row to sit on: pings (no entry at all), and — the case that must not
   * be swallowed — a clock-out whose own clock-in was dropped first, so the entry it names was
   * never created. The screen renders these itself, above the list. */
  unmatched: Attention[];
};

// The optimistic entry the clock flow wrote but no server has seen (clockFlow.localEntry: `id: ''`
// while the clock-in sits in the outbox). Merged in rather than left out, because it is the shift
// the worker is on right now and its absence would read as "that clock-in did nothing" — which is
// exactly the moment the banner above the list is explaining. Deduped on client_id, the key that
// survives the round trip, so the server's copy replaces it as soon as one arrives. It also
// rescues a forgotten open entry older than the 30-day window, which the fetch alone would miss.
//
// ponytail: merging is all this does, so it cannot *close* a row. Clock in online, then clock out
// with no signal: clockFlow.clockOutNow clears the pending entry, so openEntry is null and nothing
// is merged — but the fetched copy is still `status: 'open'`, so the row keeps pulsing "On shift"
// after the worker has clocked out. Ceiling: a wrong claim about the present, mitigated only by
// the "N actions waiting to sync" banner above the list. Upgrade path: the outbox would have to
// expose its queued clock-outs (it exposes only failures today) so the close could be merged the
// same way the open entry is.
function withOpenEntry(entries: Entry[], openEntry: Entry | null): Entry[] {
  if (!openEntry || entries.some((e) => e.client_id === openEntry.client_id)) return entries;
  return [openEntry, ...entries];
}

// 'YYYY-MM-DD' back to that local midnight. Built from parts rather than Date.parse, which reads a
// bare date string as *UTC* and would shift the label a day west of the grouping it labels.
function fromDayKey(key: string): Date {
  const [y, m, d] = key.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function dayTitle(key: string, now: Date): string {
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  // setDate, not now - 86_400_000: the day a clock goes forward is 23 hours long, and subtracting
  // a fixed 24 would land back on today.
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday)) return 'Yesterday';
  return fromDayKey(key).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * `attention` is joined on `entryClientId`, never on `clientId`. The server keeps a close's
 * idempotency key in `close_client_id` and never emits it, so every Entry row is keyed by its
 * *clock-in* id: joining a rejected clock-out by its own key would find no row and silently never
 * light the icon, which is the case a worker most needs to see (see stores/outbox.ts).
 *
 * `now` is a parameter so the Today/Yesterday titles are pinnable. The screen passes nothing and
 * gets the current instant; the labels are then as old as the last render, which the next focus or
 * pull-to-refresh replaces — a phone left on this tab across midnight shows a stale "Today".
 */
export function buildHistory(
  entries: Entry[],
  openEntry: Entry | null,
  attention: Attention[],
  now: Date = new Date(),
): History {
  const pending = new Map<string, Attention[]>();
  for (const a of attention) {
    if (!a.entryClientId) continue;
    const found = pending.get(a.entryClientId);
    if (found) found.push(a);
    else pending.set(a.entryClientId, [a]);
  }

  const days = new Map<string, HistoryRow[]>();
  for (const entry of withOpenEntry(entries, openEntry)) {
    const row: HistoryRow = {entry, attention: pending.get(entry.client_id) ?? []};
    // Consumed, so whatever is left in `pending` is by definition unjoinable.
    pending.delete(entry.client_id);
    const key = dayKey(entry.clock_in.at);
    const found = days.get(key);
    if (found) found.push(row);
    else days.set(key, [row]);
  }

  // Filtered from the original array rather than emptied out of `pending`, so the records keep the
  // order the outbox dropped them in — oldest failure first, which is the earliest real hours.
  const unmatched = attention.filter((a) => !a.entryClientId || pending.has(a.entryClientId));

  const sections = [...days.entries()]
    // Newest day first. dayKey is zero-padded 'YYYY-MM-DD', so a string compare is a date compare.
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, data]) => ({
      key,
      title: dayTitle(key, now),
      // Within a day too, and by instant rather than by string: Go trims trailing zeros off
      // RFC3339, so "10:00:00Z" sorts *after* "10:00:00.5Z" lexicographically (stores/clock.ts).
      data: data.sort((x, y) => Date.parse(y.entry.clock_in.at) - Date.parse(x.entry.clock_in.at)),
    }));

  return {sections, unmatched};
}
