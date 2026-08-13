import {useEffect, useMemo, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {dayLabel, timeRange} from '../lib/format';
import type {EmployerEntry} from '../lib/types';
import {
  addDays,
  colorFor,
  layoutWeek,
  todayKey,
  weekDays,
  weekStartOf,
  type DayKey,
  type PlacedEntry,
} from '../lib/week';

const HOURS = Array.from({length: 24}, (_, hour) => hour);

const ROW_HEIGHT = 'var(--spacing-12)';
const GRID_HEIGHT = `calc(${ROW_HEIGHT} * 24)`;
// Wide enough for "12:00" plus its inset; built from the scale rather than measured.
const GUTTER_WIDTH = 'calc(var(--spacing-12) + var(--spacing-4))';
// The plan asks for 18px; --spacing-5 is the nearest step and still a comfortable target.
const MIN_BAR_HEIGHT = 'var(--spacing-5)';
const HAIRLINE = 'var(--border-width) solid var(--color-border)';

const hoursTall = (minutes: number) => `calc(${ROW_HEIGHT} * ${minutes / 60})`;

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
  onEntryClick: (entry: EmployerEntry) => void;
}

export function WeekCalendar({
  weekStart,
  onWeekStartChange,
  tz,
  entries,
  onEntryClick,
}: WeekCalendarProps) {
  // Open shifts are drawn up to this instant; without the tick their bars freeze at the
  // minute the page happened to load.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

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
              borderBottom: HAIRLINE,
              backgroundColor:
                day === today ? 'var(--color-accent-muted)' : 'var(--color-background-surface)',
            }}>
            <Text type="label" color={day === today ? 'accent' : 'primary'}>
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
              <EntryBarPlaceholder
                key={`${bar.entry.id}-${bar.day}`}
                bar={bar}
                tz={tz}
                onClick={onEntryClick}
              />
            ))}
          </div>
        ))}
      </div>
    </VStack>
  );
}

/**
 * ponytail: a stand-in so the grid is demonstrable. Task 5.2 owns the real EntryBar with its
 * popover; it replaces this component's body and inherits the positioning wrapper unchanged.
 */
function EntryBarPlaceholder({
  bar,
  tz,
  onClick,
}: {
  bar: PlacedEntry;
  tz: string;
  onClick: (entry: EmployerEntry) => void;
}) {
  const {entry, startMin, endMin, lane, laneCount} = bar;
  const color = colorFor(entry.user.id);
  const isOpen = entry.clock_out_at === null;

  const button = (
    <button
      type="button"
      onClick={() => onClick(entry)}
      style={{
        position: 'absolute',
        top: hoursTall(startMin),
        height: `max(${MIN_BAR_HEIGHT}, ${hoursTall(endMin - startMin)})`,
        left: `${(lane / laneCount) * 100}%`,
        width: `${100 / laneCount}%`,
        display: 'flex',
        alignItems: 'start',
        justifyContent: 'space-between',
        gap: 'var(--spacing-1)',
        overflow: 'hidden',
        textAlign: 'start',
        cursor: 'pointer',
        padding: 'var(--spacing-1)',
        borderRadius: 'var(--radius-inner)',
        backgroundColor: color.background,
        color: color.text,
        // Dashed means the clock-in fell outside the anchor radius (design §6.2).
        border: `var(--border-width) ${entry.location_verified ? 'solid' : 'dashed'} ${color.border}`,
      }}>
      <Text type="supporting" color="inherit" maxLines={1}>
        {entry.user.name || entry.user.email} ·{' '}
        {timeRange(entry.clock_in_at, entry.clock_out_at, tz)}
      </Text>
      {/* Astryx's own pulse, so reduced-motion is honoured without hand-rolled keyframes. */}
      {isOpen && <StatusDot variant="success" label="Still clocked in" isPulsing />}
    </button>
  );

  if (entry.location_verified) return button;

  return (
    <Tooltip content="Clocked in outside the work location." placement="end">
      {button}
    </Tooltip>
  );
}
