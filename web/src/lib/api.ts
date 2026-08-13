// The only fetch wrapper in the app. Backend errors are
// {"error":{code,message,details}} — see backend/internal/httpx/errors.go.

// Empty string beats the ?? fallback (a copied .env.example sets VITE_API_URL=),
// which would silently bypass the dev proxy — so treat blank as unset.
const BASE_URL = import.meta.env.VITE_API_URL || '/api';

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
// method on an object the ApiProvider creates.
let getToken: (() => Promise<string>) | null = null;
let onUnauthorized: (() => void) | null = null;

/** Called once by the ApiProvider (task 2.1) so lib/ stays free of Auth0 imports. */
export function setApiAuth(handlers: {
  getToken: () => Promise<string>;
  onUnauthorized: () => void;
}): void {
  getToken = handlers.getToken;
  onUnauthorized = handlers.onUnauthorized;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (getToken) headers.set('Authorization', `Bearer ${await getToken()}`);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${BASE_URL}${path}`, {...init, headers});
  const text = await res.text();

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw toApiError(res.status, text);
  }

  // 204s (member PATCH/DELETE) and any other empty body have nothing to parse.
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

// A proxy timeout or gateway HTML page must still surface as a usable ApiError.
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
