import {useEffect, useMemo, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {dayLabel} from '../lib/format';
import type {EmployerEntry} from '../lib/types';
import {
  addDays,
  layoutWeek,
  ROW_HEIGHT,
  todayKey,
  weekDays,
  weekStartOf,
  type DayKey,
} from '../lib/week';
import {EntryBar} from './EntryBar';

const HOURS = Array.from({length: 24}, (_, hour) => hour);

const GRID_HEIGHT = `calc(${ROW_HEIGHT} * 24)`;
// Wide enough for "12:00" plus its inset; built from the scale rather than measured.
const GUTTER_WIDTH = 'calc(var(--spacing-12) + var(--spacing-4))';
const HAIRLINE = 'var(--border-width) solid var(--color-border)';
const TODAY_RULE = `calc(var(--border-width) * 3) solid var(--color-accent)`;

interface WeekCalendarProps {
  /**
   * The Sunday of the displayed week as a YYYY-MM-DD calendar date in `tz`. A string, not a
   * Date, for the reason lib/format.ts documents: a Date is an instant, and re-zoning one
   * carrying this calendar date lands on the day before in every zone behind UTC.
   */
  weekStart: DayKey;
  onWeekStartChange: (weekStart: DayKey) => void;
  /** The employer's IANA zone. Every time on this grid is wall-clock time in it. */
  tz: string;
  entries: EmployerEntry[];
}

export function WeekCalendar({weekStart, onWeekStartChange, tz, entries}: WeekCalendarProps) {
  // Open shifts are drawn up to this instant; without the tick their bars freeze at the
  // minute the page happened to load. `now` feeds the layout memo, so on a week with nothing
  // open — almost every week the employer looks at — the tick would re-segment and re-lane
  // every entry each minute to redraw the identical grid.
  const [now, setNow] = useState(() => new Date());
  const hasOpen = entries.some((e) => e.clock_out_at === null);
  useEffect(() => {
    if (!hasOpen) return;
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [hasOpen]);

  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const placed = useMemo(() => layoutWeek(entries, days, tz, now), [entries, days, tz, now]);
  const today = todayKey(tz, now);

  return (
    <VStack gap={3}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <Text type="label">
          {dayLabel(days[0], tz)} – {dayLabel(days[6], tz)}
        </Text>
        <HStack gap={2}>
          <Button
            label="Previous"
            size="sm"
            onClick={() => onWeekStartChange(addDays(weekStart, -7))}
          />
          <Button label="Today" size="sm" onClick={() => onWeekStartChange(weekStartOf(today))} />
          <Button label="Next" size="sm" onClick={() => onWeekStartChange(addDays(weekStart, 7))} />
        </HStack>
      </HStack>

      {/* ponytail: Astryx has no calendar grid, and a week view is a positioning problem —
          a time gutter, seven columns of fixed-height hours, and bars placed to the minute
          inside them — that no stack or table component expresses. Design §6.2 calls for
          hand-rolling it, so this subtree is the escape hatch, the same deal as the map
          canvas in MapAnchorPicker. Every value in it is a token or a ratio. Upgrade path
          if it grows: swizzle a real Astryx primitive rather than widening this region. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${GUTTER_WIDTH} repeat(7, minmax(0, 1fr))`,
          backgroundColor: 'var(--color-background-surface)',
          border: HAIRLINE,
          borderRadius: 'var(--radius-container)',
          overflow: 'clip',
        }}>
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            backgroundColor: 'var(--color-background-surface)',
            borderBottom: HAIRLINE,
          }}
        />
        {days.map((day) => (
          <div
            key={day}
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              padding: 'var(--spacing-2)',
              textAlign: 'center',
              borderLeft: HAIRLINE,
              // Today is marked with a brand-coloured rule under its header. --color-accent
              // is the only token carrying the brand: this theme's accent *text* and
              // accent-muted *surface* both resolve to the same neutrals as everything
              // around them, so highlighting with either is invisible.
              borderBottom: day === today ? TODAY_RULE : HAIRLINE,
              backgroundColor: 'var(--color-background-surface)',
            }}>
            <Text type="label" weight={day === today ? 'bold' : undefined}>
              {dayLabel(day, tz)}
            </Text>
          </div>
        ))}

        <div>
          {HOURS.map((hour) => (
            <div
              key={hour}
              style={{height: ROW_HEIGHT, paddingInline: 'var(--spacing-2)', textAlign: 'end'}}>
              <Text type="supporting">{hour}:00</Text>
            </div>
          ))}
        </div>

        {days.map((day) => (
          <div
            key={day}
            style={{
              position: 'relative',
              height: GRID_HEIGHT,
              borderLeft: HAIRLINE,
              // One painted rule per hour instead of 24 more elements per column.
              backgroundImage: `repeating-linear-gradient(to bottom, var(--color-border) 0, var(--color-border) var(--border-width), transparent var(--border-width), transparent ${ROW_HEIGHT})`,
            }}>
            {placed.get(day)?.map((bar) => (
              <EntryBar key={`${bar.entry.id}-${bar.day}`} bar={bar} tz={tz} />
            ))}
          </div>
        ))}
      </div>
    </VStack>
  );
}
