import {useRef, useState} from 'react';
import {Badge} from '@astryxdesign/core/Badge';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Link} from '@astryxdesign/core/Link';
import {Popover} from '@astryxdesign/core/Popover';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {flagExplanation, flagHint, flagLabel} from '../lib/flags';
import {dayLabel, lastSeen, minutesToHM, timeRange} from '../lib/format';
import type {EmployerEntry} from '../lib/types';
import {colorFor, dayKey, hoursTall, type PlacedEntry} from '../lib/week';

// The plan asks for 18px; --spacing-5 is the nearest step and still a comfortable target.
const MIN_BAR_HEIGHT = 'var(--spacing-5)';

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
  // Only meaningful while the shift is running: after clock-out the last ping is a fact about a
  // finished shift, and "last seen 4 hours ago" beside a completed one reads as a problem.
  const seen = isOpenShift ? lastSeen(entry.last_ping_at) : null;

  // The table windows on clock-in, so a shift that crossed midnight scopes to the day it
  // started — the day it will actually be found under — not to the segment that was clicked.
  const day = dayKey(entry.clock_in_at, tz) ?? bar.day;

  // One tooltip per bar, carrying everything the two glyphs on it stand for. Text's own
  // truncation tooltip is off, because it would open alongside this one on hover.
  // Flags carry their explanation here rather than their name: "Speed anomaly" on its own is a
  // word, not a verdict the employer can act on.
  const hint = [
    label,
    seen ? `On shift · ${seen.label.toLowerCase()}` : null,
    entry.location_verified ? null : 'Clocked in outside the work location',
    ...entry.flags.map(flagHint),
  ]
    .filter(Boolean)
    .join(' — ');

  return (
    <>
      {/* Suppressed while the popover is open: the pointer is still over the bar, so both
          would float over the same spot saying the same thing. */}
      <Tooltip content={hint} placement="end" isEnabled={!isPopoverOpen}>
        {/* A raw element under the hand-rolled-grid exception documented in WeekCalendar:
            no Astryx component places a child to the minute inside an hour column. */}
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
              {/* An open shift reports how recently the phone checked in instead of a duration
                  that is still climbing. A stale reading drops to grey rather than to a warning
                  colour — see lastSeen: a gap is ordinary on iOS and says nothing about the
                  worker. An em dash covers a closed shift whose timestamps will not parse, which
                  is missing data and not a shift of length zero. */}
              <Text type="supporting" color={seen && !seen.isStale ? undefined : 'secondary'}>
                {seen
                  ? `On shift · ${seen.label.toLowerCase()}`
                  : worked === null
                    ? '—'
                    : `Worked ${minutesToHM(worked)}`}
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

            {/* The chips above are two words each; this is what they claim. A line rather than a
                tooltip because this is already inside a popover, and a hover target nested in one
                is unreachable on touch. */}
            {entry.flags.map(flagExplanation).some(Boolean) && (
              <Text type="supporting" color="secondary">
                {entry.flags.map(flagExplanation).filter(Boolean).join(' · ')}
              </Text>
            )}

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
