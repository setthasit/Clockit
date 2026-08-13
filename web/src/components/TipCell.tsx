import {useCallback, useRef, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Spinner} from '@astryxdesign/core/Spinner';
// The docs name '@astryxdesign/core/useToast', but the package exports only './Toast',
// whose index re-exports the hook.
import {useToast} from '@astryxdesign/core/Toast';
import {api, ApiError} from '../lib/api';
import {useActiveEmployer} from '../lib/employer';
import {cents, toCents} from '../lib/format';
import type {DayKey} from '../lib/week';

// Mirrors the backend's 100_000_000-cent ceiling (tip/handler.go maxTipCents) so a pool the
// API would reject is caught in the field: over it, the value is rangeOverflow and
// commitField refuses to write at all. Not a stepper bound — NumberInput hides the native
// spinners — and the backend still validates regardless.
const MAX_TIP_DOLLARS = 1_000_000;

/**
 * The day's tip pool, edited in place in the table's day-header row. Dollars on screen,
 * integer cents on the wire.
 *
 * Nothing here is computed: a tip changes every member's share of that day, and the split
 * is the server's to make, so a successful PUT refetches the whole report rather than
 * touching a number locally. The single figure this cell holds across that refetch is the
 * one the PUT itself answered with — see `saved`.
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

  /**
   * The pool the PUT answered with, tagged with the prop it is standing in for. onSaved()
   * only bumps the route's attempt counter — it never clears the report — so the old rows
   * keep rendering, with no spinner and nothing pending, for the two requests the refetch
   * takes. Without this the cell would redraw the figure the user just replaced, which is
   * indistinguishable from a failed save; retyping in response would fire a second PUT.
   *
   * Not client arithmetic: it is the server's own number for this exact field, echoed only
   * until the refetch brings the same number round.
   */
  const [saved, setSaved] = useState<{cents: number; standsFor: number} | null>(null);

  // Derived, not assigned from an effect. The prop moving off the figure we saved over is
  // the refetch landing, which retires the echo; dropping the state there also stops a
  // later edit back to that same figure from reviving it. A refetch that fails instead
  // hangs nothing — the pool keeps showing what the server accepted, and the route's own
  // error banner explains why the shares beside it are stale.
  if (saved && saved.standsFor !== amount) setSaved(null);
  const shown = saved && saved.standsFor === amount ? saved.cents : amount;

  const commit = async (value: number | null) => {
    // Empty is zero, not "leave it alone": the endpoint upserts, so 0 is the only way to
    // clear a tip entered by mistake. (The rate editor treats empty as a cancel because
    // there a null rate and a zero rate are different things; a tip pool has no null.)
    const next = value === null ? 0 : toCents(value);
    // Opening the editor and leaving without a change is not a write — and a no-op PUT
    // would still spend a rate-limit token and refetch the report. Compared against what
    // the cell displays, not the prop: through the refetch gap the prop is still the
    // pre-save figure, so retyping the value just saved would otherwise write it again.
    if (next === null || next === shown) return;

    setIsSaving(true);
    try {
      const {tip} = await api<{tip: {amount_cents: number}}>(
        `/v1/employers/${employer.id}/tips/${day}`,
        {method: 'PUT', body: JSON.stringify({amount_cents: next})},
      );
      setSaved({cents: tip.amount_cents, standsFor: amount});
      onSaved();
    } catch (e) {
      // No backend message: an ownership 404 here is a wire diagnostic, not something the
      // employer can act on by editing what they just typed. A 429 is the exception — the
      // generic "try again" would be advice to do the one thing certain to fail again,
      // since the tip PUT's bucket is 30 per minute in a fixed 60-second window.
      toast({
        body:
          e instanceof ApiError && e.status === 429
            ? 'Too many tip changes just now. Wait a minute, then save this one again.'
            : 'Could not save that tip. Try again.',
        type: 'error',
      });
    } finally {
      // ponytail: the spinner ends with the PUT, so for the two requests the refetch takes
      // this day's pool is the new figure beside shares still split from the old one. It is
      // momentary and self-correcting — the refetch replaces both. Upgrade path: the route
      // would have to hold the report in a pending state across the refetch.
      setIsSaving(false);
    }
  };

  /**
   * The field, not the state. NumberInput fires no onChange when the value is emptied or
   * out of range, so `dollars` is stale for exactly the cases that decide this — an empty
   * field must write 0, and an out-of-range one must write nothing at all.
   */
  const commitField = (field: HTMLInputElement) => {
    const {rangeOverflow, rangeUnderflow, badInput} = field.validity;
    // badInput is a half-typed number — "-", ".", "1e", "12e-" — each of which type="number"
    // reports as an empty value. An intent to keep typing is not an intent to clear the
    // pool, and without this guard every one of them would write amount_cents: 0 over a
    // real tip. (A trailing dot is not among them: Chromium reads "12." as "12".)
    //
    // Three named flags rather than checkValidity(), which also fails on stepMismatch: a
    // sub-cent entry like 18.075 is one, and dropping it would lose the edit outright where
    // toCents() rounds it to the $18.08 the employer plainly meant.
    if (rangeOverflow || rangeUnderflow || badInput) return;
    void commit(field.value.trim() === '' ? null : dollars);
  };

  // Enter and Escape unmount the input, and focus would fall to <body> — a clerk entering a
  // week of tips would be dumped to the top of the tab order after every save. The trigger
  // Button takes the input's place on screen, so it takes its focus too, once it remounts
  // behind the saving spinner. Blur is deliberately not flagged: the user is already on
  // their way somewhere else, and pulling focus back would trap them here.
  const wantsFocus = useRef(false);
  const focusOnReturn = useCallback((el: HTMLButtonElement | null) => {
    if (!el || !wantsFocus.current) return;
    wantsFocus.current = false;
    el.focus();
  }, []);

  const closeKeepingFocus = () => {
    wantsFocus.current = true;
    setIsEditing(false);
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
        // A tip pool is entered to the cent, so the field's own increment is a cent. Left at
        // the default of 1, every cents-precision pool was a stepMismatch — harmless, since
        // nothing here reads that flag, but it made the field claim a $18.07 tip was invalid.
        step={0.01}
        placeholder="0.00"
        hasAutoFocus
        value={dollars}
        onChange={setDollars}
        // Enter is handled here rather than through onEnter, which carries no event and so
        // cannot see an emptied field. Closing on Enter also puts the blur that follows on
        // an unmounted fiber, which React does not deliver — so one Enter is one write.
        // Escape is the way out without committing, for the same reason.
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeKeepingFocus();
          if (e.key === 'Enter') {
            // Enter is fully handled here, and cancelling it is what makes handing focus
            // back to the trigger Button safe: closing the editor is synchronous, so the
            // Button is focused while this same keystroke is still in flight, and its
            // keypress would otherwise activate it and reopen the editor on the spot.
            e.preventDefault();
            commitField(e.currentTarget);
            closeKeepingFocus();
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
      ref={focusOnReturn}
      label={shown === 0 ? 'Add tips' : `Tips ${cents(shown)}`}
      variant="ghost"
      size="sm"
      onClick={() => {
        // Dollars in the field, cents on the wire — see toCents() for the rounding.
        setDollars(shown / 100);
        setIsEditing(true);
      }}
    />
  );
}
