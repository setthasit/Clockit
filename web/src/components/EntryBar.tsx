import {useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Link} from '@astryxdesign/core/Link';
import {Popover} from '@astryxdesign/core/Popover';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {dayLabel, minutesToHM, timeRange} from '../lib/format';
import type {EmployerEntry} from '../lib/types';
import {colorFor, dayKey, hoursTall, type PlacedEntry} from '../lib/week';

// The plan asks for 18px; --spacing-5 is the nearest step and still a comfortable target.
const MIN_BAR_HEIGHT = 'var(--spacing-5)';

// The backend's only flag today. Unknown values fall through as their wire name rather
// than disappearing: a flag the employer cannot see is worse than one that reads oddly.
const FLAG_LABELS: Record<string, string> = {speed_anomaly: 'Speed anomaly'};

const flagLabel = (flag: string) => FLAG_LABELS[flag] ?? flag;

/**
 * Worked minutes from the two timestamps rather than from `duration_minutes`, for the same
 * reason the bar's height comes from them (see week.ts): one source, so the popover can
 * never claim a length the bar above it does not draw. Null while the shift is open.
 */
function workedMinutes(entry: EmployerEntry): number | null {
  if (!entry.clock_out_at) return null;
  const ms = new Date(entry.clock_out_at).getTime() - new Date(entry.clock_in_at).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
}

interface EntryBarProps {
  bar: PlacedEntry;
  /** The employer's IANA zone. Every time on this bar is wall-clock time in it. */
  tz: string;
}

export function EntryBar({bar, tz}: EntryBarProps) {
  const {entry, startMin, endMin, lane, laneCount} = bar;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);

  const color = colorFor(entry.user.id);
  const who = entry.user.name || entry.user.email;
  const times = timeRange(entry.clock_in_at, entry.clock_out_at, tz);
  const label = `${who} · ${times}`;
  const isOpenShift = entry.clock_out_at === null;
  const flags = entry.flags.map(flagLabel);
  const worked = workedMinutes(entry);

  // The table windows on clock-in, so a shift that crossed midnight scopes to the day it
  // started — the day it will actually be found under — not to the segment that was clicked.
  const day = dayKey(entry.clock_in_at, tz) ?? bar.day;

  // One tooltip per bar, carrying everything the two glyphs on it stand for. Text's own
  // truncation tooltip is off, because it would open alongside this one on hover.
  const hint = [
    label,
    entry.location_verified ? null : 'Clocked in outside the work location',
    ...flags,
  ]
    .filter(Boolean)
    .join(' — ');

  return (
    <>
      {/* Suppressed while the popover is open: the pointer is still over the bar, so both
          would float over the same spot saying the same thing. */}
      <Tooltip content={hint} placement="end" isEnabled={!isPopoverOpen}>
        <button
          ref={triggerRef}
          type="button"
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
          <Text type="supporting" color="inherit" maxLines={1} hasTruncateTooltip={false}>
            {label}
          </Text>
          {(flags.length > 0 || isOpenShift) && (
            <HStack gap={1} vAlign="center">
              {/* The warning glyph is the closest fit in Astryx's semantic icon set, and a
                  flag is exactly "this shift wants a second look". */}
              {flags.length > 0 && <Icon icon="warning" size="xsm" label={flags.join(', ')} />}
              {/* Astryx's own pulse, so reduced-motion is honoured without hand-rolled keyframes. */}
              {isOpenShift && <StatusDot variant="success" label="Still clocked in" isPulsing />}
            </HStack>
          )}
        </button>
      </Tooltip>

      {/* Sibling mode. In children mode the popover anchors to a wrapper it renders itself,
          and this button is absolutely positioned, so it would leave that wrapper collapsed
          at the top of the day column and the popover would open nowhere near the bar. */}
      <Popover
        anchorRef={triggerRef as React.RefObject<HTMLElement>}
        onOpenChange={setIsPopoverOpen}
        label={`Shift details for ${who}`}
        placement="end"
        width={280}
        content={
          <VStack gap={3}>
            <VStack gap={1}>
              <Text type="label" weight="bold">
                {who}
              </Text>
              <Text type="body">
                {dayLabel(entry.clock_in_at, tz)} · {times}
              </Text>
              <Text type="supporting" color="secondary">
                {worked === null ? 'Still clocked in' : `Worked ${minutesToHM(worked)}`}
              </Text>
            </VStack>

            <HStack gap={2} wrap="wrap">
              <Badge
                variant={entry.location_verified ? 'success' : 'warning'}
                label={entry.location_verified ? 'Location verified' : 'Location not verified'}
              />
              {entry.flags.map((flag) => (
                <Badge
                  key={flag}
                  variant="warning"
                  icon={<Icon icon="warning" size="xsm" />}
                  label={flagLabel(flag)}
                />
              ))}
            </HStack>

            {/* The contract task 6.1 reads back: /table?from=&to= as YYYY-MM-DD day keys in
                the employer's zone, the same keys the calendar lays out on. */}
            <Link href={`/table?from=${day}&to=${day}`} isStandalone>
              View in table
            </Link>
          </VStack>
        }
      />
    </>
  );
}
