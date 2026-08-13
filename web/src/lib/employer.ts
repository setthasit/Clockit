import {createContext, useContext} from 'react';
import type {Employer} from './types';

export interface EmployerState {
  employers: Employer[];
  /** null only when the caller owns none — the /onboarding case. */
  employer: Employer | null;
  setEmployerId: (id: string) => void;
  /** Re-fetches GET /v1/employers. How a freshly created employer enters the app. */
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
