import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { createStaffPortal } from '../src/portal.js';
import { validateDevelopmentCertificate } from '../src/development-tls.js';
import { createAuth0VerificationServer, prepareAuth0Verification } from '../src/auth0-verification-server.js';
import { config, fixture } from './fixtures/auth0-fixture.js';

let pfx: Buffer, certificate: Buffer, passphrase: string, directory: string;
before(() => {
  const pfxPath = process.env['NUKHBAPAY_STAFF_TEST_PFX_PATH'], certPath = process.env['NUKHBAPAY_STAFF_TEST_CA_PATH'];
  passphrase = process.env['NUKHBAPAY_STAFF_TEST_PASSPHRASE'] ?? '';
  directory = process.env['NUKHBAPAY_STAFF_TEST_TLS_CASES_DIR'] ?? '';
  assert.ok(pfxPath && certPath && passphrase && directory);
  pfx = readFileSync(pfxPath); certificate = readFileSync(certPath);
});

test('public certificate checks deny expiry, future validity, CA, hostname, EKU and malformed material', () => {
  const cert = new X509Certificate(certificate);
  assert.equal(validateDevelopmentCertificate(certificate).fingerprint256, cert.fingerprint256);
  assert.throws(() => validateDevelopmentCertificate(certificate, Date.parse(cert.validFrom) - 1));
  assert.throws(() => validateDevelopmentCertificate(certificate, Date.parse(cert.validTo)));
  assert.throws(() => validateDevelopmentCertificate(certificate, NaN));
  for (const name of ['ca', 'wrong-host', 'client-only', 'wrong-subject', 'extra-san', 'wildcard']) {
    assert.throws(() => validateDevelopmentCertificate(readFileSync(join(directory, name + '.pem'))));
  }
  assert.throws(() => validateDevelopmentCertificate(Buffer.from('synthetic-invalid-certificate')));
});

test('non-CA localhost leaf needs no certificate-signing usage to verify its self-signature', () => {
  const cert = new X509Certificate(certificate);
  assert.equal(cert.ca, false);
  // OpenSSL checks issuer capability here, not the cryptographic self-signature.
  assert.equal(cert.checkIssued(cert), false);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(validateDevelopmentCertificate(certificate).fingerprint256, cert.fingerprint256);
});

test('matching issuer and subject cannot authorize a tampered self-signature', () => {
  const cert = new X509Certificate(certificate), tampered = Buffer.from(cert.raw);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  const bad = new X509Certificate(tampered);
  assert.equal(bad.issuer, bad.subject);
  assert.equal(bad.subjectAltName, 'DNS:localhost');
  assert.equal(bad.verify(bad.publicKey), false);
  assert.throws(() => validateDevelopmentCertificate(tampered), { message: 'Staff HTTPS certificate validation failed' });
});

test('a valid same-key signature cannot authorize a different issuer name', () => {
  const issued = readFileSync(join(directory, 'wrong-issuer.pem')), cert = new X509Certificate(issued);
  assert.equal(cert.ca, false);
  assert.equal(cert.subject, 'CN=localhost');
  assert.equal(cert.subjectAltName, 'DNS:localhost');
  assert.notEqual(cert.issuer, cert.subject);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.throws(() => validateDevelopmentCertificate(issued), { message: 'Staff HTTPS certificate validation failed' });
});

test('portal refuses corrupt PFX, wrong passphrase and mismatched public certificate even with same RSA key', async () => {
  for (const changes of [
    { pfx: Buffer.from('synthetic-invalid-pfx') }, { passphrase: 'synthetic-wrong-passphrase' },
    { certificate: readFileSync(join(directory, 'mismatch.pem')) },
  ]) await assert.rejects(() => createStaffPortal({ pfx, certificate, passphrase, port: 0, ...changes }));
});

function call(origin: string, path: string, headers: Record<string, string> = {}, tls: Record<string, unknown> = {}) {
  const port = Number(new URL(origin).port);
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, servername: 'localhost', path,
      ca: new X509Certificate(certificate).toString(), rejectUnauthorized: true, agent: false,
      headers: { host: `localhost:${port}`, ...headers }, ...tls }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
}
async function freePort() {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}

test('TLS refuses IP hostname and protocols below TLS 1.2', async () => {
  const runtime = await createStaffPortal({ pfx, certificate, passphrase, port: 0 });
  try {
    await assert.rejects(() => call(runtime.origin, '/', {}, { servername: '127.0.0.1' }));
    await assert.rejects(() => call(runtime.origin, '/', {}, { minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }));
  } finally { await runtime.close(); }
});

test('standalone harness verifies synthetic provider pair, emits only booleans and no application session', async () => {
  const port = await freePort(), origin = `https://localhost:${port}`;
  const f = await fixture(origin + '/auth/callback');
  const runtime = await createAuth0VerificationServer({ config: { ...config, callbackUrl: origin + '/auth/callback' },
    pfx, certificate, passphrase, fetch: f.fetch, now: f.now });
  try {
    assert.equal((await call(origin, '/auth/login', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await call(origin, '/', { host: 'wrong.invalid' })).status, 400);
    for (const path of ['/auth/session', '/auth/me', '/auth/logout', '/auth/access-token', '/auth/login?tenant=forged']) {
      assert.equal((await call(origin, path)).status, 404);
    }
    const started = await call(origin, '/auth/login'); assert.equal(started.status, 303);
    const url = new URL(started.headers.location!);
    f.id({ nonce: url.searchParams.get('nonce')! });
    const callback = '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! });
    const cookie = started.headers['set-cookie']![0]!.split(';')[0]!;
    assert.equal((await call(origin, callback, { cookie, origin: 'https://wrong.invalid' })).status, 403);
    assert.equal((await call(origin, callback, { cookie, 'sec-fetch-mode': 'cors' })).status, 403);
    const response = await call(origin, callback, { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { verified: true, sessionCreated: false });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['set-cookie']!.length, 1);
    assert.match(response.headers['set-cookie']![0]!, /^__Host-nukhbapay_oidc=;.*Max-Age=0/);
    assert.deepEqual(await runtime.outcome, { verified: true, sessionCreated: false });
    assert.equal(f.rows.size, 0); assert.equal(f.exchanges(), 1);
    assert.equal((await call(origin, callback, { cookie })).status, 401);
    assert.equal(f.exchanges(), 1);
  } finally { await runtime.close(); }
});

test('standalone harness denies ambiguous transaction cookies without a provider exchange', async () => {
  const port = await freePort(), origin = `https://localhost:${port}`;
  const f = await fixture(origin + '/auth/callback');
  const runtime = await createAuth0VerificationServer({ config: { ...config, callbackUrl: origin + '/auth/callback' },
    pfx, certificate, passphrase, fetch: f.fetch, now: f.now });
  try {
    const started = await call(origin, '/auth/login'), url = new URL(started.headers.location!);
    const cookie = started.headers['set-cookie']![0]!.split(';')[0]!;
    const response = await call(origin, '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! }), { cookie: cookie + ';' + cookie });
    assert.equal(response.status, 401); assert.deepEqual(await runtime.outcome, { verified: false, sessionCreated: false });
    assert.equal(f.exchanges(), 0); assert.equal(f.rows.size, 0);
  } finally { await runtime.close(); }
});

test('verification preparation is local, rejects activation and TLS bypasses, never reflects secrets', () => {
  const env = {
    NUKHBAPAY_ENVIRONMENT: 'development', NUKHBAPAY_STAFF_AUTH0_ISSUER: config.issuer,
    NUKHBAPAY_STAFF_AUTH0_CLIENT_ID: config.clientId, NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET: config.clientSecret,
    NUKHBAPAY_STAFF_AUTH0_AUDIENCE: config.audience, NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM: 'https://claims.nukhbapay.com/principal',
    NUKHBAPAY_STAFF_AUTH0_TENANT_ID: config.tenantId,
    NUKHBAPAY_STAFF_TLS_PFX_PATH: process.env['NUKHBAPAY_STAFF_TEST_PFX_PATH']!,
    NUKHBAPAY_STAFF_TLS_CERT_PATH: process.env['NUKHBAPAY_STAFF_TEST_CA_PATH']!, NUKHBAPAY_STAFF_TLS_PASSPHRASE: passphrase,
  };
  assert.equal(prepareAuth0Verification(env).config.callbackUrl, 'https://localhost:3001/auth/callback');
  for (const changes of [
    { NUKHBAPAY_STAFF_SESSION_MODE: 'auth0' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { NODE_OPTIONS: '--inspect' },
    { NUKHBAPAY_ENVIRONMENT: 'production' }, { NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM: config.staffKindClaim },
    { NUKHBAPAY_STAFF_TLS_PASSPHRASE: 'synthetic-private-wrong-passphrase' }, { NUKHBAPAY_STAFF_TLS_PFX_PATH: 'relative.pfx' },
  ]) assert.throws(() => prepareAuth0Verification({ ...env, ...changes }), { message: 'Auth0 verification-only acceptance unavailable' });
});
