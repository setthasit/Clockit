import {useEffect} from 'react';

// The suffix every title carries, so a pinned tab still says which app it is once the label
// itself is truncated away.
const APP = 'ClockIt';

/**
 * Sets the document title for as long as a route is mounted.
 *
 * Deliberately never restores the previous title on unmount: routes replace each other, so the
 * incoming route's effect has already written the new title by the time a cleanup would run, and
 * restoring would put the old one back over it.
 */
export function useDocumentTitle(label: string | null): void {
  const title = label ? `${label} — ${APP}` : APP;
  useEffect(() => {
    document.title = title;
  }, [title]);
}
