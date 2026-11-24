import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { StaffCatalogueService } from '@nukhbapay/application';
import { attestVerifiedStaffIdentity } from '@nukhbapay/application/verified-identity';
import type { Pool } from 'pg';
import { createStaffCatalogueReader } from '../src/staff-catalogue-reader.js';

function fixture() {
  const tenant = randomUUID(), staff = randomUUID(), product = randomUUID();
  const seen: { query: string; parameters: unknown[] }[] = [];
  const releases: boolean[] = [];
  let pricing = true, commitFailure = false, auditFailure = false, audits = 0;
  const pool = {
    connect: async () => ({
      release: (discard: boolean) => releases.push(discard),
      query: async (query: string, parameters: unknown[] = []) => {
        seen.push({ query, parameters });
        if (query === 'COMMIT') {
          if (commitFailure) throw new Error('Sensitive driver failure');
          return { command: 'COMMIT', rows: [] };
        }
        if (query.includes('DISTINCT provider_code')) return { rows: [{ provider_code: 'synthetic' }] };
        if (query.includes('FROM nukhabapay.products')) {
          return { rows: [{ id: product, name: 'Card', country: 'AE', service: 'DIGITAL_PIN' }] };
        }
        if (query.includes('FROM nukhabapay.provider_offers')) {
          return { rows: [{ id: randomUUID(), product_id: product, provider_code: 'synthetic',
            available: true, valid_until: new Date('2026-11-20T10:00:00Z'), cost: '9123',
            observed_at: new Date('2026-11-19T09:00:00Z'), completed_at: new Date('2026-11-19T09:01:00Z') }] };
        }
        if (query.includes('FROM nukhabapay.price_workflow_versions v JOIN')) return { rows: [{
          id: randomUUID(), product_id: product, revision: '9007199254740993', kind: 'ROLLBACK',
          occurred_at: new Date('2026-11-19T09:30:00Z'),
        }] };
        if (query.includes('SELECT DISTINCT ON')) return { rows: [{
          product_id: product, candidate_id: 'a'.repeat(64), selected_provider_id: 'synthetic',
          total: '10200', cost: '9123', service: '200', payment: '173', commission: '50', margin: '854',
        }] };
        return { rows: [] };
      },
    }),
  } as unknown as Pool;
  const read = createStaffCatalogueReader(pool, new Map([[tenant, [
    { country: 'AE', service: 'DIGITAL_PIN', providerId: 'synthetic', enabled: true },
    { country: 'SA', service: 'DIGITAL_PIN', providerId: 'missing', enabled: true },
  ]]]));
  // Future policy double exercises only the adapter. Deployment uses the fixed permission catalogue.
  const service = new StaffCatalogueService({
    authority: { require: async (_identity, scope, permission) => ({
      staffId: staff, tenantId: scope,
      revalidate: async () => permission !== 'pricing.read' || pricing,
    }) },
    read, now: () => new Date('2026-11-19T10:00:00Z'),
    audit: async () => { audits++; if (auditFailure) throw new Error('Audit unavailable'); },
  });
  const identity = attestVerifiedStaffIdentity({
    issuer: 'https://staff.invalid/', subject: 'fixture',
    security: {
      audience: 'fixture', clientId: 'fixture', profile: 'rfc9068-staff-v1', principalKind: 'human',
      issuedAt: Date.parse('2026-11-19T09:59:00Z') / 1000,
      expiresAt: Date.parse('2026-11-19T10:05:00Z') / 1000, assurance: 'not-established',
    },
  });
  return { read, service, tenant, identity, seen, releases,
    refusePricing: () => { pricing = false; }, failCommit: () => { commitFailure = true; },
    failAudit: () => { auditFailure = true; }, audits: () => audits };
}

test('durable reads consume scoped tickets and basic views avoid selecting provider cost', async () => {
  const f = fixture();
  await assert.rejects(f.read({ tenantId: f.tenant, view: 'products', revalidate: async () => true }));
  await assert.rejects(f.service.read(f.identity, randomUUID(), 'products', {}));
  assert.equal(f.seen.length, 0);
  const page = await f.service.read(f.identity, f.tenant, 'products', {});
  assert.equal(page.items[0]?.['available'], true);
  assert.equal(page.items[0]?.['providerCost'], undefined);
  assert.equal(f.seen.some(call => call.query.includes('provider_debit_minor')), false);
  const offerQuery = f.seen.find(call => call.query.includes('FROM nukhabapay.provider_offers'));
  assert.match(offerQuery?.query ?? '', /newer.tenant_id=s.tenant_id AND newer.provider_account_id=s.provider_account_id/);
  assert.match(offerQuery?.query ?? '', /newer.status='COMPLETE'/);
  assert.ok(f.seen.filter(call => call.parameters.length).every(call => call.parameters[0] === f.tenant));
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.audits(), 1);
  const countries = await f.service.read(f.identity, f.tenant, 'countries', { group: 'GCC' });
  assert.equal(countries.items.find(row => row.id === 'SA')?.['configured'], false);
});

test('private stored economics preserve exact amounts and require fresh pricing authority and audit', async () => {
  const f = fixture();
  const result = await f.service.read(f.identity, f.tenant, 'economics', {});
  assert.equal(result.items[0]?.['total'], '102.00');
  assert.equal(result.items[0]?.['providerCost'], '91.23');
  assert.equal(result.items[0]?.['canPublish'], false);
  const offers = await f.service.read(f.identity, f.tenant, 'offers', {});
  assert.equal(offers.items[0]?.['sourceObservedAt'], '2026-11-19T09:00:00.000Z');
  assert.equal(offers.items[0]?.['sourceCompletedAt'], '2026-11-19T09:01:00.000Z');
  const history = await f.service.read(f.identity, f.tenant, 'publications', {});
  assert.equal(history.items[0]?.['revision'], '9007199254740993');
  assert.equal(history.items[0]?.['action'], 'ROLLBACK');
  assert.ok(f.seen.some(call => call.query.includes('price_workflow_audit') && call.parameters[0] === f.tenant));
  f.failAudit();
  await assert.rejects(f.service.read(f.identity, f.tenant, 'economics', {}), /Audit unavailable/);
  f.refusePricing();
  const queryCount = f.seen.length;
  await assert.rejects(f.service.read(f.identity, f.tenant, 'economics', {}), { status: 403 });
  assert.equal(f.seen.length, queryCount);
});

test('catalogue read discards a connection with uncertain commit and withholds audit and response', async () => {
  const f = fixture();
  f.failCommit();
  await assert.rejects(f.service.read(f.identity, f.tenant, 'products', {}), /Catalogue reader unavailable/);
  assert.equal(f.seen.at(-1)?.query, 'ROLLBACK');
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.audits(), 0);
});
