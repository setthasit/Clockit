import {WebAuthError, WebAuthErrorCodes} from 'react-native-auth0';

import {useClockStore} from '@/stores/clock';
import {clearForSignOut} from '@/stores/outbox';
import {useSessionStore} from '@/stores/session';

/**
 * Ending a session, in the one order that is safe.
 *
 * A module rather than a handler in app/(tabs)/profile.tsx, for lib/clockFlow.ts's reason: every
 * branch below is a way to hand one worker's hours to another worker, or to destroy them, and none
 * of them can be reached by hand — they need a cancelled browser logout, an offline logout, or a
 * kill inside a two-call window. Inside a component none of it is reachable, since this repo has no
 * renderer. The screen keeps what only a screen can have: the confirmation, the busy flag, and
 * where the message is drawn.
 *
 * **The queue is not scoped to a user** (stores/outbox.ts). Everything here exists because of that.
 *
 * ponytail: this is not the only way out of a session — an unrecoverable 401 ends one too
 * (app/_layout.tsx), and that path deliberately keeps the queue, because a 401 is retryable and the
 * same worker's unsent hours must survive it. So a worker who is 401'd out and replaced on a shared
 * phone leaves their queue behind for the next sign-in to flush under a different Auth0 sub.
 * Ceiling: exactly that hand-over. Upgrade path is outbox.ts's per-sub scoping, which 9.1 inherits
 * along with the flush triggers that would fire the queue.
 */

/**
 * `done: false` with a null message is the worker backing out of the browser logout: nothing was
 * touched, nothing to say, and the screen leaves its confirmation where it was so the choice is not
 * lost. Same shape and same rule as ClockResult (lib/clockFlow.ts).
 */
export type SignOutResult = {done: boolean; message: string | null};

/** Only reachable when the keychain itself refuses, which is not something a worker can act on
 * beyond trying again — so no diagnosis is offered, and the Auth0 error is never shown: it can
 * carry session detail (the rule stores/session.ts and app/sign-in.tsx both follow). */
export const SIGN_OUT_FAILED = 'Could not sign out. Please try again.';

/** The two `useAuth0()` actions this needs, named structurally so the sequence can be driven by a
 * test. Both are hook-bound, which is why they are passed in rather than imported. */
type Auth0SignOut = {
  clearSession: () => Promise<void>;
  clearCredentials: () => Promise<void>;
};

/**
 * Wipes every device-wide trace of the signed-out worker.
 *
 * Enumerated rather than left to a loop, because a store missed here is a leak onto the next person
 * to use the phone — the shift-work case this app is for:
 *
 *  - **outbox** — `clearForSignOut()`, never the two obvious lines inline. Its own comment has the
 *    full argument; the short version is that `persist.clearStorage()` cancels an in-flight launch
 *    rehydrate *including* the callback that releases the flush gate, so open-coding it can wedge
 *    the queue dead for the process lifetime, while omitting it lets the custom `merge` resurrect
 *    the previous worker's clock-in and send it under the new account.
 *  - **clock** — `reset()`, which also bumps the store's write generation. Without that bump a
 *    `hydrateFromServer()` already in flight — issued with the previous worker's token — lands its
 *    answer afterwards and puts their open shift, and their coordinates, back on screen.
 *  - **session** — `clear()`, which is the one that flips the gate's `me` to null. Last by
 *    defence, not by guarantee: all three calls are synchronous inside one task and React batches,
 *    so nothing can currently interleave and inverting the order is unobservable (there is nothing
 *    here to test). It stays last because data-before-UI costs nothing and is the order that keeps
 *    holding if any of the three ever grows an async step or an out-of-batch subscriber.
 *
 * **ui is deliberately not cleared.** `locationExplainerSeen` is device-scoped by construction
 * (stores/ui.ts) and holds nothing about the user, so it leaks nothing. Clearing it would re-show a
 * blocking screen to a worker who dismissed it months ago, and would buy a new worker on a shared
 * phone very little: the OS permission is device-wide too, so it is already granted or already
 * denied by the previous worker, and the first clock-in is where task 6.1 puts the real recourse.
 */
function wipeLocalState(): void {
  clearForSignOut();
  useClockStore.getState().reset();
  useSessionStore.getState().clear();
}

/**
 * Sign out. Returns rather than throws: a button handler that rejects leaves the screen with no way
 * to be correct (lib/clockFlow.ts makes the same choice).
 *
 * **The caller owes the worker a warning first when `outbox.items.length > 0`** — this destroys
 * unsent hours, and stores/outbox.ts survives a dead session precisely so they are not lost.
 *
 * Order, and why each step is where it is:
 *
 *  1. `clearSession()` first, because it is the only step the worker can *refuse*. It opens a
 *     browser for the federated logout, and the SDK's own implementation
 *     (hooks/Auth0Provider.tsx) is `webAuth.clearSession()` -> `credentialsManager.
 *     clearCredentials()` -> `LOGOUT_COMPLETE` — so a cancel rejects before the credentials are
 *     touched and leaves the session fully intact. Wiping first and asking second would destroy a
 *     queue for a sign-out that then did not happen, and that window is seconds wide because a
 *     human is looking at a dialog inside it.
 *  2. A cancel is the only rejection that stops everything. Any *other* failure falls back to
 *     `clearCredentials()`, which is local and needs no network: `webAuth.clearSession` has to load
 *     a logout URL, and refusing to sign out in a dead zone would strand a worker who is handing
 *     the phone over — the ordinary case in shift work, and the case this app is built around.
 *  3. The local wipe runs if and only if the credentials are actually gone, in every branch. That
 *     is the invariant worth having: there is no path that ends with the queue cleared but the
 *     previous worker still signed in, and none that ends with them signed out but their queue
 *     still on disk for the next person's first flush to send.
 *
 * ponytail: a residual remains at step 3 — a kill between the SDK clearing the keychain and
 * `clearForSignOut()` landing leaves the queue on disk with the session already gone, which is the
 * leak. It is milliseconds wide against the seconds-wide window that reordering would open, so it
 * is the right way round, not the safe one. Upgrade path: drive `webAuth.clearSession()` and
 * `credentialsManager.clearCredentials()` separately off the non-hook client (stores/session.ts
 * already owns one) and put the wipe between them, which closes it without reopening the cancel.
 *
 * ponytail: the offline fallback ends the local session but leaves Auth0's own browser cookie, so
 * the next sign-in on that phone may complete without re-prompting — i.e. as the previous worker.
 * Ceiling: an offline hand-over. Not closable from here (the logout endpoint is the cookie's only
 * owner); the alternative was refusing to sign out at all, which is worse. Upgrade path: remember
 * that the federated logout is owed and retry it on the next launch with a connection.
 *
 * ponytail: signing out mid-shift does not stop location tracking, because there is nothing to
 * stop yet — location/tracking.ts is phase 5's empty hook pair. `onClockedOut()` is deliberately
 * *not* called here: its contract is "the worker tapped", and a sign-out is not a clock-out, so
 * calling it would tell phase 5 the shift ended when the server still has it open. Phase 5 owes
 * this file a "stop tracking, the shift is unchanged" call of its own.
 */
export async function signOut(auth0: Auth0SignOut): Promise<SignOutResult> {
  try {
    await auth0.clearSession();
  } catch (e) {
    // The same test app/sign-in.tsx uses on authorize(). NativeWebAuthProvider wraps every
    // clearSession failure in a WebAuthError, and Auth0Provider rethrows it untouched.
    if (e instanceof WebAuthError && e.type === WebAuthErrorCodes.USER_CANCELLED) {
      return {done: false, message: null};
    }
    try {
      await auth0.clearCredentials();
    } catch {
      // Credentials are still on the device, so nothing local may be wiped: leaving the worker
      // signed in with their queue intact is recoverable, and half a sign-out is not.
      return {done: false, message: SIGN_OUT_FAILED};
    }
  }

  wipeLocalState();
  return {done: true, message: null};
}
