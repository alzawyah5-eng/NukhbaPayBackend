import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { consumeCatalogueReadTicket } from '@nukhbapay/application';
import type { CatalogueReader, CatalogueAuditWriter, CatalogueRow } from '@nukhbapay/application';
import { exercisePublishedCatalogueHttp } from './fixtures/published-catalogue-http.js';

// Reuses the accepted HTTP assertions with explicit in-memory ports. No PostgreSQL acceptance is implied.
test('integrated synthetic catalogue HTTP security works without database activation',async()=>{
  const tenantId=randomUUID(),otherTenantId=randomUUID(),productId=randomUUID(),secondProductId=randomUUID();
  const unpublishedId=randomUUID(),oldVersion=randomUUID();
  let readerDenied=false,auditDenied=false,reads=0,audits=0;
  const rows=new Map<string,CatalogueRow>([[productId,{productId,name:'SYNTHETIC',publicationId:oldVersion,totalMinor:'10200',validUntil:'2026-11-09T10:30:00Z'}]]);
  const reader:CatalogueReader={read:async value=>{
    const ticket=consumeCatalogueReadTicket(value);reads++;
    assert.equal(await ticket.revalidate(),true);
    if(readerDenied)throw new Error('Synthetic reader unavailable');
    assert.ok(ticket.tenantId===tenantId||ticket.tenantId===otherTenantId);
    return ticket.tenantId===tenantId?[...rows.values()].filter(row=>Date.parse(row.validUntil)>ticket.nowMs):[];
  }};
  const audit:CatalogueAuditWriter={append:async event=>{
    if(auditDenied)throw new Error('Synthetic audit unavailable');
    assert.ok(event.tenantId===tenantId||event.tenantId===otherTenantId);
    assert.match(event.clientDigest,/^[0-9a-f]{64}$/);audits++;
  }};
  await exercisePublishedCatalogueHttp({reader,audit,tenantId,otherTenantId,productId,secondProductId,unpublishedId,oldVersion,
    activateSecond:async()=>{rows.set(secondProductId,{productId:secondProductId,name:'SYNTHETIC SECOND',publicationId:randomUUID(),totalMinor:'10400',validUntil:'2026-11-09T10:30:00Z'});},
    republish:async()=>{const operationId=randomUUID();rows.set(productId,{...rows.get(productId)!,publicationId:operationId,totalMinor:'10300'});return {operationId};},
    denyReader:async()=>{readerDenied=true;},restoreReader:async()=>{readerDenied=false;},
    denyAudit:async()=>{auditDenied=true;},restoreAudit:async()=>{auditDenied=false;},
  });
  assert.ok(reads>0&&audits>0);
});
