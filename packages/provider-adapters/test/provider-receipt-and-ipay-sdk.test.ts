import assert from 'node:assert/strict';
import test from 'node:test';
import { providerJsonNumber } from '../src/catalogue-http.ts';
import { createIronGatePostpaidReceiptReader, createIronGatePrepaidReceiptReader } from '../src/index.ts';
import { IpaySdk } from '../src/ipay-sdk.ts';

const account = { tenantId: '00000000-0000-4000-8000-000000000001', providerAccountId: '00000000-0000-4000-8000-000000000002' };
const origin = 'https://provider-receipt.fixture.invalid';
const providerTransactionId = '90071992547409927';
const attempt = { ...account, providerTransactionId, transactionReference: 'fixture-ref', customerId: '0007252', productCode: 'fixture-product' };

test('IronGate raw prepaid receipts use a bound transaction and return only approved fields', async () => {
  let calls = 0;
  let response: Record<string, unknown> = { tr_id: providerJsonNumber(providerTransactionId), ref_id: attempt.transactionReference,
    product_code: attempt.productCode, customer_id: attempt.customerId, rc: '00', status: 1,
    admin_fee: '0.0100', price: providerJsonNumber('9007199254740993.49'), sn: 'fixture-private', name: 'private fixture' };
  const read = createIronGatePrepaidReceiptReader({ account, baseUrl: origin, successCode: '00', transport: async (url, init) => {
    calls++;
    assert.equal(url, `${origin}/api/download/${providerTransactionId}/1`);
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), null);
    assert.equal(init.redirect, 'error');
    return Response.json({ data: response });
  } });
  await assert.rejects(read({ ...attempt, tenantId: account.providerAccountId }), { code: 'SCOPE_DENIED' });
  await assert.rejects(read({ ...attempt, providerTransactionId: '../../balance' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  assert.deepEqual(await read(attempt), { outcome: 'OBSERVED', providerTransactionId, transactionReference: attempt.transactionReference,
    status: 1, price: '9007199254740993.49', adminFee: '0.0100' });
  response = { ...response, ref_id: 'unrelated' };
  assert.deepEqual(await read(attempt), { outcome: 'UNCONFIRMED' });
  assert.equal(calls, 2);
});

test('IronGate postpaid PDF receipts require a paid inquiry and return only the private storage reference', async () => {
  const inquiryId = '90071992547409933';
  const receipt = '00000000-0000-4000-8000-000000000003';
  const pdf = '%PDF-1.7\nfixture-private-receipt\n%%EOF\n';
  const paid = { ...account, status:'PAID' as const, inquiryId, transactionReference:'fixture-postpaid' };
  let lookup = false, calls = 0, stored = 0, mode: 'valid' | 'redirect' | 'bad-body' | 'bad-media' = 'valid';
  const read = createIronGatePostpaidReceiptReader({ account,baseUrl:origin,
    readPaidInquiry:async (scope,id) => {
      assert.deepEqual(scope,account);
      assert.equal(id,inquiryId);
      return lookup ? paid : undefined;
    }, getUsername:async () => 'account+fixture@example.invalid',
    storeReceipt:async (scope,bytes) => {
      stored++;
      assert.deepEqual(scope,paid);
      assert.equal(Buffer.from(bytes).toString(),pdf);
      return receipt;
    }, transport:async (url,init) => {
      calls++;
      assert.equal(url,`${origin}/api/v1/download/${inquiryId}/0/account%2Bfixture%40example.invalid`);
      assert.equal(init?.method,'GET');
      assert.equal(init.redirect,'error');
      assert.equal(new Headers(init.headers).get('accept'),'application/pdf');
      if (mode === 'redirect') return Response.redirect('https://other.invalid/receipt');
      return new Response(mode === 'bad-body' ? '%PDF-1.7\nno end' : pdf,
        { headers:{ 'Content-Type':mode === 'bad-media' ? 'text/html' : 'application/pdf' } });
    } });
  await assert.rejects(read({ ...account,tenantId:account.providerAccountId },inquiryId),{ code:'SCOPE_DENIED' });
  await assert.rejects(read(account,'../123'),{ code:'INVALID_REQUEST' });
  await assert.rejects(read(account,inquiryId),{ code:'SCOPE_DENIED' });
  assert.equal(calls,0);
  lookup = true;
  assert.deepEqual(await read(account,inquiryId),{ outcome:'OBSERVED',inquiryId,receipt });
  for (const failure of ['redirect','bad-body','bad-media'] as const) {
    mode = failure;
    assert.deepEqual(await read(account,inquiryId),{ outcome:'UNCONFIRMED' });
  }
  assert.equal(calls,4);
  assert.equal(stored,1);
});

test('iPay preserves the exact available SDK XML operation names, escaped credentials and decimal text', async () => {
  let resolves = 0, calls = 0;
  const requests = ['<RequestXml><Type>Version</Type></RequestXml>',
    '<RequestXml><Type>GetBalanceSt</Type><TerminalId>fixture-terminal</TerminalId><Password>fixture&lt;&gt;&amp;credential</Password><Language>en</Language></RequestXml>',
    '<RequestXml><Type>Query</Type><TerminalId>fixture-terminal</TerminalId><Password>fixture&lt;&gt;&amp;credential</Password><Language>en</Language><OriginalRefNo>fixture-ref</OriginalRefNo></RequestXml>'];
  const replies = [{ Version: '2017.1' }, { StatusCode: '0', Balance: '9007199254740993.0400', CompanyPhone: 'fixture-only' },
    { StatusCode: '0', TransNo: '000888', Amount: '10.0700', ProductCode: 'fixture-product', PinData: [{ Pin: 'fixture-pin' }] }];
  const sdk = new IpaySdk({ account, language: 'en', allowedOperations: ['version','balance','query'], getCredentials: async bound => {
    resolves++;
    assert.deepEqual(bound, account);
    return { terminalId: 'fixture-terminal', password: 'fixture<>&credential' };
  }, processXml: async body => {
    assert.equal(body, requests[calls]);
    return replies[calls++];
  } });
  assert.deepEqual(await sdk.execute(account, { operation: 'version' }), { outcome: 'OBSERVED', version: '2017.1' });
  assert.equal(resolves, 0);
  assert.deepEqual(await sdk.execute(account, { operation: 'balance' }), { outcome: 'OBSERVED', balance: '9007199254740993.0400' });
  assert.deepEqual(await sdk.execute(account, { operation: 'query', productCode: attempt.productCode, originalReference: attempt.transactionReference,
    transactionNumber: '000888' }), { outcome: 'OBSERVED', transactionNumber: '000888', amount: '10.0700' });
  assert.equal(resolves, 2);
  assert.equal(calls, 3);
});

test('iPay rejects unauthorized operations and mismatched vendor transaction responses', async () => {
  let calls = 0;
  const sdk = new IpaySdk({ account, allowedOperations: ['query'],
    getCredentials: async () => ({ terminalId: 'fixture-terminal', password: 'fixture-password' }), processXml: async () => {
      calls++;
      return { StatusCode: '0', ProductCode: 'fixture-product', TransNo: 'other-trans', Amount: '12.00' };
    } });
  const query = { operation: 'query', productCode: 'fixture-product', originalReference: attempt.transactionReference, transactionNumber: '000888' } as const;
  await assert.rejects(sdk.execute(account, { operation: 'version' }), { code: 'SCOPE_DENIED' });
  await assert.rejects(sdk.execute({ ...account, providerAccountId: account.tenantId }, query), { code: 'SCOPE_DENIED' });
  await assert.rejects(sdk.execute(account, { ...query, originalReference: '<PinRequest>' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  assert.deepEqual(await sdk.execute(account, query), { outcome: 'UNCONFIRMED' });
  assert.equal(calls, 1);
});
