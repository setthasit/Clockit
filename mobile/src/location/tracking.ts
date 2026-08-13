import type {Entry} from '@/api/entries';

/**
 * Phase-5 hook points, empty on purpose. Task 6.4's clock flow (lib/clockFlow.ts) is the only
 * caller and already calls both — phase 5 fills these in and touches nothing else.
 *
 * The contract phase 5 inherits, all three parts load-bearing:
 *
 *  1. **Both fire on the queued path too.** A clock-in that could not be sent still puts the
 *     worker on shift locally (the outbox replays it later), so tracking must start; a queued
 *     clock-out still ends the shift, so tracking must stop or the phone keeps pinging for a
 *     shift that is over. "The server said yes" is not the trigger — "the worker tapped" is.
 *
 *  2. **`entry` may be optimistic**: `id` is `''` and `location_verified` is false until the
 *     server answers. Key nothing off `entry.id`. Nothing needs it — a ping carries neither an
 *     entry reference nor an idempotency key on the wire (api/entries.ts `Ping`), the server
 *     attaches a batch to whatever entry is open when it arrives. `clock_in.at`, `employer_id`
 *     and `client_id` are real from the first moment.
 *
 *  3. **Neither may throw.** They are called after the clock state is committed, so a throw here
 *     would report a landed clock-in to the screen as a failed one.
 */
export function onClockedIn(entry: Entry): void {}

export function onClockedOut(): void {}
