import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSession, signOut } from '../client/src/session.js';

test('session client distinguishes denied, expired, unavailable and malformed responses without fallback identity', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, kind] of [[401, 'anonymous'], [403, 'forbidden'], [503, 'unavailable']] as const) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, '/auth/session'); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
        return new Response('{}', { status });
      };
      assert.deepEqual(await readSession(), { kind });
    }
    for (const payload of [{ authenticated: true }, { authenticated: false }, { authenticated: true, csrfToken: 'forged' }]) {
      globalThis.fetch = async () => Response.json(payload);
      assert.deepEqual(await readSession(), { kind: 'unavailable' });
    }
    globalThis.fetch = async () => Response.json({ authenticated: true, csrfToken: 'A'.repeat(43) });
    assert.deepEqual(await readSession(), { kind: 'authenticated', csrfToken: 'A'.repeat(43) });
    globalThis.fetch = async () => { throw new Error('Offline'); };
    assert.deepEqual(await readSession(), { kind: 'unavailable' });
  } finally { globalThis.fetch = original; }
});

test('logout sends only the CSRF token and confirms success only after the BFF returns 204', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [204, 200, 401, 403, 503]) {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, '/auth/logout'); assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}');
        assert.equal(init?.credentials, 'same-origin');
        assert.deepEqual(init?.headers, { 'content-type': 'application/json', 'x-csrf-token': 'A'.repeat(43) });
        return new Response(null, { status });
      };
      assert.equal(await signOut('A'.repeat(43)), status === 204);
    }
    globalThis.fetch = async () => { throw new Error('Offline'); };
    assert.equal(await signOut('A'.repeat(43)), false);
  } finally { globalThis.fetch = original; }
});
