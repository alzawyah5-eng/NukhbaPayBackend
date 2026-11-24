import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.NUKHBA_R6_STAGED_ROOT;
if (!root) throw new Error('Use scripts/reconcile-r6-offline.py to rebuild and test R6');
const { PublishedCatalogueService, attestCatalogueClient, consumeCatalogueReadTicket, CATALOGUE_AUDIENCES, CATALOGUE_SCOPES } =
  await import(pathToFileURL(path.join(root, 'packages/application/dist/application/src/catalog/published-catalogue.js')));

for (const [expiryLookup, status, expectedReads] of [[1, 401, 0], [3, 403, 1]]) {
  test(`staged R6 denies expiry during binding lookup ${expiryLookup}`, async () => {
    let now = 1700000000000, lookups = 0, reads = 0, audits = 0;
    const id = '00000000-0000-4000-8000-000000000001';
    const identity = attestCatalogueClient({
      issuer: 'https://catalog.synthetic.invalid', subject: 'fixture', clientId: 'fixture',
      kind: 'payment', audience: CATALOGUE_AUDIENCES.payment, scope: CATALOGUE_SCOPES.payment,
      issuedAt: now / 1000, expiresAt: now / 1000 + 10,
    });
    const svc = new PublishedCatalogueService({
      capability: 'SYNTHETIC_PUBLISHED_CATALOGUE_ONLY', now: () => new Date(now),
      bindings: { find: async () => {
        if (++lookups === expiryLookup) now += 10000;
        return { ...identity, tenantId: id, kioskId: null, enabled: true, version: '1' };
      } },
      reader: { read: async ticket => {
        consumeCatalogueReadTicket(ticket);
        reads++;
        return [{ productId: id, publicationId: id, name: 'Fixture', totalMinor: '1000',
          validUntil: new Date(now + 60000).toISOString() }];
      } },
      audit: { append: async () => { audits++; } },
    });
    await assert.rejects(svc.read(identity, { kind: 'payment', query: {} }), { status });
    assert.equal(reads, expectedReads);
    assert.equal(audits, expectedReads);
  });
}
