import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecureContext } from 'node:tls';
import { TRANSACTION_COOKIE_NAME, transactionCookie, type Auth0Configuration } from './auth0.js';
import { readPendingAuth0Configuration } from './auth0-configuration.js';
import { Auth0VerificationOnly, type VerificationOutcome } from './auth0-verification-only.js';
import { probeDevelopmentHttps, validateDevelopmentCertificate } from './development-tls.js';

const failed = () => new Error('Auth0 verification-only acceptance unavailable');
const denied: VerificationOutcome = Object.freeze({ verified: false, sessionCreated: false });

/** Standalone development listener. Ordinary BFF startup never imports or calls this. */
export async function createAuth0VerificationServer(options: {
  config: Auth0Configuration; pfx: Buffer; certificate: Buffer; passphrase: string;
  fetch?: typeof fetch; now?: () => Date;
}) {
  const certificate = validateDevelopmentCertificate(options.certificate);
  const origin = new URL(options.config.callbackUrl).origin;
  const port = Number(new URL(origin).port);
  const verifier = new Auth0VerificationOnly(options.config, {
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}),
  });
  let finish!: (outcome: VerificationOutcome) => void;
  const outcome = new Promise<VerificationOutcome>(resolve => { finish = resolve; });
  const server = createServer({ pfx: options.pfx, passphrase: options.passphrase,
    minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status: number, body: string, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type + '; charset=utf-8' }); res.end(body);
    };
    void (async () => {
      if (req.headersDistinct['host']?.length !== 1 || req.headers.host !== new URL(origin).host ||
          req.rawHeaders.length > 128) { send(400, '{"error":"Invalid request"}'); return; }
      const callback = req.method === 'GET' && req.url?.startsWith('/auth/callback?');
      // Provider callback is the sole cross-site exception. No Origin is accepted there.
      if (callback ? req.headersDistinct['origin'] !== undefined ||
          req.headersDistinct['sec-fetch-site'] !== undefined && (req.headersDistinct['sec-fetch-site'].length !== 1 ||
            !['cross-site', 'same-site', 'same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) ||
          req.headersDistinct['sec-fetch-mode'] !== undefined && (req.headersDistinct['sec-fetch-mode'].length !== 1 || req.headers['sec-fetch-mode'] !== 'navigate') ||
          req.headersDistinct['sec-fetch-dest'] !== undefined && (req.headersDistinct['sec-fetch-dest'].length !== 1 || req.headers['sec-fetch-dest'] !== 'document') :
          req.headersDistinct['origin'] !== undefined && (req.headersDistinct['origin'].length !== 1 || req.headers.origin !== origin) ||
          req.headersDistinct['sec-fetch-site'] !== undefined && (req.headersDistinct['sec-fetch-site'].length !== 1 ||
            !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) {
        send(403, '{"error":"Request denied"}'); return;
      }
      if (req.method === 'GET' && req.url === '/health/live') { send(200, '{"status":"ok"}'); return; }
      if (req.method === 'GET' && req.url === '/') {
        send(200, '<!doctype html><title>Auth0 development verification</title><p>Token verification only. No staff session will be created.</p><a href="/auth/login">Verify once with Auth0</a>', 'text/html'); return;
      }
      if (req.method === 'GET' && req.url === '/auth/login') {
        const started = verifier.begin();
        res.setHeader('Set-Cookie', started.cookie);
        res.writeHead(303, { location: started.location }); res.end(); return;
      }
      if (callback) {
        // Reject ambiguous cookies. Only the ephemeral OIDC transaction cookie is read.
        const headers = req.headersDistinct['cookie'];
        const parts = headers?.length === 1 && headers[0]!.length <= 2048 ? headers[0]!.split(';') : [];
        const values = parts.map(p => p.trim()).filter(p => p.startsWith(TRANSACTION_COOKIE_NAME + '='));
        const value = values.length === 1 ? values[0]!.slice(TRANSACTION_COOKIE_NAME.length + 1) : undefined;
        const result = await verifier.complete(req.url!, value);
        res.setHeader('Set-Cookie', transactionCookie('', true));
        res.once('finish', () => finish(result));
        send(result.verified ? 200 : 401, JSON.stringify(result)); return;
      }
      send(404, '{"error":"Not found"}');
    })().catch(() => { if (!res.headersSent) send(503, '{"error":"Verification unavailable"}'); else res.destroy(); });
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000; server.maxHeadersCount = 64;
  server.setTimeout(10000, socket => socket.destroy());
  server.on('tlsClientError', () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clearTimeout(timer); verifier.close(); finish(denied);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    await probeDevelopmentHttps(port, certificate);
    timer = setTimeout(() => { void close(); }, 300_000);
    timer.unref();
    return Object.freeze({ origin, outcome, close });
  } catch { await close(); throw failed(); }
}

/** No network/listener in prepare mode. No tokens accepted in argv, env, stdin or files. */
export function prepareAuth0Verification(env: Readonly<Record<string, string | undefined>>) {
  try {
    if ((env['NUKHBAPAY_STAFF_SESSION_MODE'] ?? 'disabled') !== 'disabled' ||
        env['NODE_TLS_REJECT_UNAUTHORIZED'] !== undefined && env['NODE_TLS_REJECT_UNAUTHORIZED'] !== '1' ||
        env['NODE_OPTIONS']) throw failed();
    const config = readPendingAuth0Configuration(env);
    if (config.staffKindClaim !== 'https://claims.nukhbapay.com/principal') throw failed();
    const pfxPath = env['NUKHBAPAY_STAFF_TLS_PFX_PATH'], certPath = env['NUKHBAPAY_STAFF_TLS_CERT_PATH'];
    const passphrase = env['NUKHBAPAY_STAFF_TLS_PASSPHRASE'];
    if (!pfxPath || !isAbsolute(pfxPath) || !certPath || !isAbsolute(certPath) || !passphrase || passphrase.length < 32) throw failed();
    const certificate = readFileSync(certPath), pfx = readFileSync(pfxPath);
    validateDevelopmentCertificate(certificate);
    createSecureContext({ pfx, passphrase, minVersion: 'TLSv1.2' });
    return { config, pfx, certificate, passphrase };
  } catch { throw failed(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void (async () => {
    if (process.argv.length !== 3 || !['--prepare', '--run-approved-development-verification'].includes(process.argv[2]!)) throw failed();
    const options = prepareAuth0Verification(process.env);
    if (process.argv[2] === '--prepare') {
      console.info('Local configuration and public certificate valid. Provider authentication and browser trust remain unverified.'); return;
    }
    const runtime = await createAuth0VerificationServer(options);
    const close = () => { void runtime.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    console.info('Verification only: open https://localhost:3001 within five minutes. No staff session will be issued.');
    try {
      const result = await runtime.outcome;
      console.info(JSON.stringify(result));
      if (!result.verified) process.exitCode = 1;
    } finally { process.off('SIGINT', close); process.off('SIGTERM', close); await runtime.close(); }
  })().catch(() => { console.error('Auth0 verification-only acceptance unavailable'); process.exitCode = 1; });
}
