import { createServer } from 'node:http';
import { loadKioskAssets } from '../apps/admin-web/dist/kiosk-assets.js';

if (process.env.NUKHBAPAY_ENVIRONMENT !== 'aws-staging' || process.env.NODE_ENV !== 'production') {
  throw new Error('Expected the AWS staging kiosk runtime');
}

const assets = loadKioskAssets('/app/kiosk/');
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health/ready') {
    response.writeHead(200).end();
    return;
  }
  if (request.headersDistinct.host?.length !== 1 || request.headers.host !== 'staging.nukhbapay.com' ||
      request.headersDistinct['x-forwarded-proto']?.length !== 1 || request.headers['x-forwarded-proto'] !== 'https') {
    response.writeHead(403).end();
    return;
  }
  const path = request.url === '/kiosk/' ? '/kiosk' : request.url;
  const asset = (request.method === 'GET' || request.method === 'HEAD') && path ? assets.get(path) : undefined;
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': asset.body.length,
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Content-Type': asset.type,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }).end(request.method === 'HEAD' ? undefined : asset.body);
});
server.listen(8080, '0.0.0.0', () => console.info('AWS staging kiosk is ready'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
