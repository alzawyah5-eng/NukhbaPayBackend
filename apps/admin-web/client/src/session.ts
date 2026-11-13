export type SessionState =
  | { kind: 'loading' | 'anonymous' | 'unavailable' | 'forbidden' }
  | { kind: 'authenticated'; csrfToken: string };

// Only the existing same-origin BFF is contacted. Cookies are HttpOnly; CSRF stays in memory.
export async function readSession(signal?: AbortSignal): Promise<SessionState> {
  try {
    const response = await fetch('/auth/session', {
      credentials: 'same-origin', cache: 'no-store', signal: signal ?? null,
    });
    if (response.status === 401) return { kind: 'anonymous' };
    if (response.status === 403) return { kind: 'forbidden' };
    if (!response.ok) return { kind: 'unavailable' };
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null && 'authenticated' in data && data.authenticated === true &&
      'csrfToken' in data && typeof data.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)) {
      return { kind: 'authenticated', csrfToken: data.csrfToken };
    }
  } catch { /* Render a safe retry state, never a fabricated session. */ }
  return { kind: 'unavailable' };
}

export async function signOut(csrfToken: string): Promise<boolean> {
  try {
    const response = await fetch('/auth/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{}',
    });
    return response.status === 204;
  } catch { return false; }
}
