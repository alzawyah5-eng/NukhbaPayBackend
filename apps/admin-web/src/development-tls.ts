import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

const unavailable = () => new Error('Staff HTTPS certificate validation failed');

/** Public certificate inspection only; neither reads nor changes system trust. */
export function validateDevelopmentCertificate(input: Buffer, now = Date.now()): X509Certificate {
  try {
    const certificate = new X509Certificate(input);
    const key = certificate.publicKey;
    const bits = key.asymmetricKeyDetails?.modulusLength;
    if (!Number.isSafeInteger(now) || certificate.ca || certificate.subject !== 'CN=localhost' ||
        certificate.subjectAltName !== 'DNS:localhost' ||
        certificate.checkHost('localhost', { subject: 'never', wildcards: false }) !== 'localhost' ||
        !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.1') ||
        // checkIssued requires issuer keyCertSign usage, which a non-CA server leaf must not need.
        // Require a self-issued name AND verify the self-signature; neither alone establishes trust.
        certificate.issuer !== certificate.subject || !certificate.verify(key) ||
        key.asymmetricKeyType !== 'rsa' || !bits || bits < 2048 || bits > 4096 ||
        now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) throw unavailable();
    return certificate;
  } catch { throw unavailable(); }
}

/** Proves hostname, dates, signature and presented PFX/public certificate equality. */
export async function probeDevelopmentHttps(port: number, certificate: X509Certificate): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const probe = request({ hostname: '127.0.0.1', port, servername: 'localhost', path: '/health/live',
        headers: { host: `localhost:${port}` }, ca: certificate.toString(), rejectUnauthorized: true,
        checkServerIdentity: (hostname, peer) => checkServerIdentity(hostname, peer) ??
          (peer.raw && certificate.raw.equals(peer.raw) ? undefined : unavailable()),
        agent: false, timeout: 3000 }, response => {
        response.resume();
        response.once('end', () => response.statusCode === 200 ? resolve() : reject(unavailable()));
      });
      probe.once('error', reject);
      probe.once('timeout', () => probe.destroy(unavailable()));
      probe.end();
    });
  } catch { throw unavailable(); }
}
