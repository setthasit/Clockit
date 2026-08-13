import {createContext, useContext} from 'react';
import type {Employer} from './types';

export interface EmployerState {
  employers: Employer[];
  /** null only when the caller owns none — the /onboarding case. */
  employer: Employer | null;
  setEmployerId: (id: string) => void;
  /**
   * Seeds a just-created employer into the list and selects it, synchronously. Onboarding
   * needs this rather than refresh(): the guard bounces every route back to /onboarding
   * while the list is empty, and refresh() only *schedules* a refetch, so a navigate that
   * follows it loses the race. POST /v1/employers returns the same shape the list does,
   * so there is nothing a refetch would add.
   */
  addEmployer: (employer: Employer) => void;
  /**
   * Replaces an edited employer in place, synchronously — Settings' save path. Same
   * reasoning as addEmployer: PATCH returns the full employer, so a refetch would add
   * nothing, and refresh() only *schedules* one, leaving the top-bar name and the
   * timezone the calendar and table bucket by stale until it lands.
   */
  updateEmployer: (employer: Employer) => void;
  /** Re-fetches GET /v1/employers. Recovery from a failed load. */
  refresh: () => void;
}

/** Provided by GuardedLayout, which already fetches the list. Read it with useEmployer(). */
export const EmployerContext = createContext<EmployerState | null>(null);

export const EMPLOYER_ID_KEY = 'clockit.employerId';

export function useEmployer(): EmployerState {
  const state = useContext(EmployerContext);
  if (!state) throw new Error('useEmployer() must be called inside GuardedLayout');
  return state;
}

/**
 * The active employer, non-null. Valid only under <Shell/>: GuardedLayout redirects to
 * /onboarding while the list is empty, so by the time Shell renders there is at least one
 * employer and the `?? employers[0]` fallback always resolves.
 *
 * Use this instead of useEmployer() in Shell routes. Every date in this app is formatted
 * in the employer's IANA timezone, and an `employer?.timezone ?? browserTimezone` fallback
 * would silently render another timezone's days rather than fail.
 */
export function useActiveEmployer(): Employer {
  const {employer} = useEmployer();
  if (!employer) throw new Error('useActiveEmployer() is only valid inside Shell');
  return employer;
}
