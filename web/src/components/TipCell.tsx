import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Spinner} from '@astryxdesign/core/Spinner';
// The docs name '@astryxdesign/core/useToast', but the package exports only './Toast'.
import {useToast} from '@astryxdesign/core/Toast';
import {api} from '../lib/api';
import {useActiveEmployer} from '../lib/employer';
import {cents, toCents} from '../lib/format';
import type {DayKey} from '../lib/week';

// Mirrors the backend's 100_000_000-cent ceiling so the stepper stops where the API does.
// The backend still validates: this only keeps the arrows from walking past it.
const MAX_TIP_DOLLARS = 1_000_000;

/**
 * The day's tip pool, edited in place in the table's day-header row. Dollars on screen,
 * integer cents on the wire.
 *
 * Nothing here is computed: a tip changes every member's share of that day, and the split
 * is the server's to make, so a successful PUT refetches the whole report rather than
 * touching a number locally. That also makes the failure path free — the cell never showed
 * anything but the server's own figure, so a failed write leaves the old pool on screen
 * beside the old shares, which is exactly what is still true.
 */
export function TipCell({
  day,
  cents: amount,
  onSaved,
}: {
  day: DayKey;
  cents: number;
  onSaved: () => void;
}) {
  const employer = useActiveEmployer();
  const toast = useToast();
  const [dollars, setDollars] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const commit = async (value: number | null) => {
    // Empty is zero, not "leave it alone": the endpoint upserts, so 0 is the only way to
    // clear a tip entered by mistake. (The rate editor treats empty as a cancel because
    // there a null rate and a zero rate are different things; a tip pool has no null.)
    const next = value === null ? 0 : toCents(value);
    // Opening the editor and leaving without a change is not a write — and a no-op PUT
    // would still spend a rate-limit token and refetch the report.
    if (next === null || next === amount) return;

    setIsSaving(true);
    try {
      await api<void>(`/v1/employers/${employer.id}/tips/${day}`, {
        method: 'PUT',
        body: JSON.stringify({amount_cents: next}),
      });
      onSaved();
    } catch {
      // No backend message: a rate limit or an ownership 404 here is a wire diagnostic,
      // not something the employer can act on by editing what they just typed.
      toast({body: 'Could not save that tip. Try again.', type: 'error'});
    } finally {
      // ponytail: the spinner ends with the PUT, not with the refetch it triggers, so for
      // that gap the cell shows the old pool next to the old shares — stale together, which
      // is at least consistent. Upgrade path: the route would have to own the pending tip.
      setIsSaving(false);
    }
  };

  /**
   * The field, not the state. NumberInput fires no onChange when the value is emptied or
   * out of range, so `dollars` is stale for exactly the cases that decide this — an empty
   * field must write 0, and an out-of-range one must write nothing at all. Not
   * checkValidity(): `step` makes a legitimate $12.50 a stepMismatch and would drop it.
   */
  const commitField = (field: HTMLInputElement) => {
    const {rangeOverflow, rangeUnderflow, badInput} = field.validity;
    // badInput is a half-typed number ("12."), which type="number" reports as an empty
    // value — an intent to keep typing, not an intent to clear the tip.
    if (rangeOverflow || rangeUnderflow || badInput) return;
    void commit(field.value.trim() === '' ? null : dollars);
  };

  if (isSaving) return <Spinner size="sm" aria-label="Saving tips" />;

  if (isEditing) {
    return (
      <NumberInput
        label="Tips for this day"
        isLabelHidden
        size="sm"
        width={130}
        min={0}
        max={MAX_TIP_DOLLARS}
        placeholder="0.00"
        hasAutoFocus
        value={dollars}
        onChange={setDollars}
        // Enter is handled here rather than through onEnter, which carries no event and so
        // cannot see an emptied field. Closing on Enter also puts the blur that follows on
        // an unmounted fiber, which React does not deliver — so one Enter is one write.
        // Escape is the way out without committing, for the same reason.
        onKeyDown={(e) => {
          if (e.key === 'Escape') setIsEditing(false);
          if (e.key === 'Enter') {
            commitField(e.currentTarget);
            setIsEditing(false);
          }
        }}
        onBlur={(e) => {
          commitField(e.target);
          setIsEditing(false);
        }}
      />
    );
  }

  return (
    <Button
      label={amount === 0 ? 'Add tips' : `Tips ${cents(amount)}`}
      variant="ghost"
      size="sm"
      onClick={() => {
        // Dollars in the field, cents on the wire — see toCents() for the rounding.
        setDollars(amount / 100);
        setIsEditing(true);
      }}
    />
  );
}
