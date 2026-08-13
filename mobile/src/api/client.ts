// The only fetch wrapper in the app. Backend errors are
// {"error":{code,message,details}} — see backend/internal/httpx/errors.go.

// Blank is treated as unset: a copied .env.example leaves EXPO_PUBLIC_API_URL=
// and there is no sensible fallback — localhost cannot resolve from a device.
const BASE_URL = process.env.EXPO_PUBLIC_API_URL || '';

const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ponytail: module-level singletons rather than a context-bound client. Ceiling is
// one authenticated API per app; if a second identity is ever needed, make api() a
// method on an object the session provider creates.
let getToken: (() => Promise<string>) | null = null;
let onUnauthorized: (() => void) | null = null;

/** Called once at app start (task 2.1) so this file stays free of stores/ and Auth0 imports. */
export function setApiAuth(handlers: {
  getToken: () => Promise<string>;
  onUnauthorized: () => void;
}): void {
  getToken = handlers.getToken;
  onUnauthorized = handlers.onUnauthorized;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE_URL) {
    throw new ApiError(
      0,
      'NETWORK',
      'EXPO_PUBLIC_API_URL is not set. Copy mobile/.env.example to mobile/.env and point it at your machine’s LAN IP.',
    );
  }

  const headers = new Headers(init?.headers);
  if (getToken) {
    try {
      headers.set('Authorization', `Bearer ${await getToken()}`);
    } catch {
      // Expired refresh token / no stored credentials rejects here with no HTTP 401
      // ever sent, so this is the only path back to sign-in. The caught error is not
      // logged: it can carry token and session detail.
      onUnauthorized?.();
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Please sign in again.');
    }
  }
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  // AbortSignal.timeout() is typed by TS's DOM lib but absent from React Native's
  // abort-controller polyfill, so it would throw at runtime on Hermes.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  let res: Response;
  try {
    // ponytail: our signal replaces any caller-supplied one — nothing composes them
    // (AbortSignal.any is also missing on Hermes). Wire composition in if a screen
    // ever needs to cancel a request early.
    res = await fetch(`${BASE_URL}${path}`, {...init, headers, signal: controller.signal});
  } catch {
    // Offline, DNS failure, abort — all indistinguishable to the outbox, which
    // retries on status === 0 || status >= 500 (task 5.2).
    throw new ApiError(
      0,
      'NETWORK',
      timedOut ? 'The request timed out.' : 'Could not reach the server. Check your connection.',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw toApiError(res.status, text);
  }

  if (!text) return undefined as T;

  const data = parseJson(text);
  if (data === undefined) {
    throw new ApiError(res.status, 'UNKNOWN', 'The server returned a malformed response.');
  }
  return data as T;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A LAN proxy timeout or gateway HTML page must still surface as a usable ApiError.
function toApiError(status: number, text: string): ApiError {
  const body = parseJson(text) as {error?: Record<string, unknown>} | undefined;
  const err = typeof body === 'object' && body !== null ? body.error : undefined;
  const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN';
  const message =
    typeof err?.message === 'string' ? err.message : `Request failed with status ${status}.`;
  const details =
    typeof err?.details === 'object' && err.details !== null
      ? (err.details as Record<string, unknown>)
      : undefined;

  return new ApiError(status, code, message, details);
}
