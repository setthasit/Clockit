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
