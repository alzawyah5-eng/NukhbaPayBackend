import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpaySoapProcess, IpaySdk } from '../src/ipay-sdk.ts';
import { encodeIpayXmlText } from '../src/ipay-soap.ts';
import { createIpayPasswordRotation } from '../src/ipay-password-rotation.ts';

const account = { tenantId:'00000000-0000-4000-8000-000000000001', providerAccountId:'00000000-0000-4000-8000-000000000002' };
const namespace = 'urn:fixture:ipay:transaction';
const credentials = { terminalId:'fixture-terminal', password:'fixture-password' };
const pinPurchase = { operation:'pinPurchase', reference:'purchase-fixture1', receiptNumber:'00001', productCode:'FX0001', valueCode:'12.30' } as const;
const start = { operation:'pinlessStart', reference:'pinless-fixture1', receiptNumber:'00001', productCode:'FX0002', accountNumber:'000662', amount:'12.30' } as const;
const confirm = { ...start, operation:'pinlessConfirm', firstTransactionNumber:'0000000000011' } as const;
const refund = { operation:'pinRefund', reference:'refund-fixture1', receiptNumber:'00001', originalTransactionNumber:'0000000000013' } as const;

const base = { account, getCredentials: async (scope: typeof account) => {
  assert.deepEqual(scope, account);
  return credentials;
} };

function soapProcess(serve: (request: string) => string) {
  return createIpaySoapProcess({ endpoint:'https://fixture.invalid/ecsoap', namespace, action:'urn:fixture:ipay:Process', requestElementNamespace:'',
    resultElement:'ProcessResult', resultElementNamespace:namespace, transport: async (_url,init) => {
      const payload = serve(String(init?.body));
      return new Response('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        `<soap:Body><ProcessResponse xmlns="${namespace}"><ProcessResult>${encodeIpayXmlText(payload)}</ProcessResult>` +
        '</ProcessResponse></soap:Body></soap:Envelope>', { headers:{ 'Content-Type':'text/xml' } });
    } });
}

test('iPay purchase requires a protected issued-PIN store and returns an opaque receipt', async () => {
  let sent = 0, stored = 0, reservations = 0;
  const pin = 'fixture-issued-secret';
  const vaultReceipt = '00000000-0000-4000-8000-000000000003';
  const options = { ...base, allowedOperations:['pinPurchase'] as const, reserveMutation: async () => ++reservations === 1,
    processXml: soapProcess(body => {
      sent++;
      assert.match(body, /&lt;Type&gt;PinRequest&lt;\/Type&gt;/);
      assert.match(body, /&lt;ReceiptNo&gt;00001&lt;\/ReceiptNo&gt;&lt;RefNo&gt;purchase-fixture1&lt;\/RefNo&gt;/);
      assert.match(body, /&lt;ProdCode&gt;FX0001&lt;\/ProdCode&gt;&lt;ValueCode&gt;12\.30&lt;\/ValueCode&gt;/);
      return `<ResponseXml><StatusCode>0</StatusCode><TransNo>0000000000013</TransNo><PinData><Pin>${pin}</Pin><PinSerial>000882</PinSerial></PinData></ResponseXml>`;
    }) };
  assert.throws(() => new IpaySdk(options),{ code:'INVALID_CONFIGURATION' });
  const sdk = new IpaySdk({ ...options, storeIssuedPin: async (scope, reference, transaction, issued) => {
    stored++;
    assert.deepEqual(scope,account);
    assert.equal(reference,pinPurchase.reference);
    assert.equal(transaction,'0000000000013');
    assert.deepEqual(issued,{ Pin:pin, PinSerial:'000882' });
    return vaultReceipt;
  } });
  const result = await sdk.execute(account,pinPurchase);
  assert.deepEqual(result,{ outcome:'OBSERVED', phase:'PIN_STORED', reference:pinPurchase.reference,
    transactionNumber:'0000000000013', receipt:vaultReceipt });
  assert.ok(!JSON.stringify(result).includes(pin));
  await assert.rejects(sdk.execute(account,pinPurchase),{ code:'SCOPE_DENIED' });
  assert.equal(sent,1);
  assert.equal(stored,1);
});

test('iPay binds PINless confirmation to the exact admitted first-step request and keeps refunds separate', async () => {
  let calls = 0;
  let prior: Readonly<Record<string,string>> | undefined;
  let confirmed = false;
  const sdk = new IpaySdk({ ...base, allowedOperations:['pinlessStart','pinlessConfirm','pinRefund'], pinlessProducts:['FX0002'],
    reserveMutation: async (scope, intent) => {
      assert.deepEqual(scope,account);
      assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.fields));
      if (intent.operation === 'pinlessStart') { prior = intent.fields; return true; }
      if (intent.operation === 'pinRefund') return intent.fields['CardData'] === refund.originalTransactionNumber;
      if (!prior || confirmed || intent.firstTransactionNumber !== '0000000000011' || JSON.stringify(prior) !== JSON.stringify(intent.fields)) return false;
      confirmed = true;
      return true;
    }, processXml: soapProcess(body => {
      calls++;
      if (calls === 1 || calls === 2) {
        const type = calls === 1 ? 'PinlessRequest' : 'PinlessRequest2ndStep';
        assert.ok(body.includes(`&lt;Type&gt;${type}&lt;/Type&gt;`));
        assert.match(body,/&lt;RefNo&gt;pinless-fixture1&lt;\/RefNo&gt;/);
        assert.match(body,/&lt;ProdCode&gt;FX0002&lt;\/ProdCode&gt;&lt;AccountNo&gt;000662&lt;\/AccountNo&gt;&lt;Amount&gt;12\.30&lt;\/Amount&gt;/);
        assert.doesNotMatch(body,/0000000000011/);
        return '<ResponseXml><StatusCode>0</StatusCode><TransNo>0000000000011</TransNo><AuthorizationCode/></ResponseXml>';
      }
      assert.match(body,/&lt;Type&gt;PinlessRequest&lt;\/Type&gt;/);
      assert.match(body,/&lt;CardData&gt;0000000000013&lt;\/CardData&gt;&lt;Amount&gt;0&lt;\/Amount&gt;&lt;ProdCode&gt;REFUND&lt;\/ProdCode&gt;/);
      return '<ResponseXml><StatusCode>0</StatusCode><TransNo>0000000000019</TransNo><AuthorizationCode>fixture-confirmed</AuthorizationCode></ResponseXml>';
    }) });
  await assert.rejects(sdk.execute(account,confirm),{ code:'SCOPE_DENIED' });
  await assert.rejects(sdk.execute(account,{ ...start,productCode:'REFUND' }),{ code:'SCOPE_DENIED' });
  await assert.rejects(sdk.execute(account,{ ...start,amount:'12.301' }),{ code:'INVALID_REQUEST' });
  assert.equal(calls,0);
  assert.deepEqual(await sdk.execute(account,start),{ outcome:'OBSERVED',phase:'CONFIRMATION_REQUIRED',reference:start.reference,transactionNumber:'0000000000011' });
  await assert.rejects(sdk.execute(account,{ ...confirm,amount:'12.40' }),{ code:'SCOPE_DENIED' });
  assert.deepEqual(await sdk.execute(account,confirm),{ outcome:'OBSERVED',phase:'ACKNOWLEDGED',reference:start.reference,transactionNumber:'0000000000011' });
  await assert.rejects(sdk.execute(account,confirm),{ code:'SCOPE_DENIED' });
  assert.deepEqual(await sdk.execute(account,refund),{ outcome:'OBSERVED',phase:'ACKNOWLEDGED',reference:refund.reference,transactionNumber:'0000000000019' });
  assert.equal(calls,3);
});

test('iPay keeps transport and vault failures unconfirmed and never retries financial submissions', async () => {
  let calls = 0;
  const failed = new IpaySdk({ ...base, allowedOperations:['pinlessStart'],pinlessProducts:['FX0002'], reserveMutation:async () => true,
    processXml: async () => { calls++; throw new Error('fixture private transport error'); } });
  assert.deepEqual(await failed.execute(account,start),{ outcome:'UNCONFIRMED' });
  assert.equal(calls,1);
  const missing = new IpaySdk({ ...base, allowedOperations:['pinlessStart'],pinlessProducts:['FX0002'], reserveMutation:async () => true,
    processXml: async () => ({ StatusCode:'0', TransNo:'0000000000001' }) });
  assert.deepEqual(await missing.execute(account,start),{ outcome:'UNCONFIRMED' });
  const failedVault = new IpaySdk({ ...base, allowedOperations:['pinPurchase'],reserveMutation:async () => true,
    storeIssuedPin:async () => { throw new Error('fixture private vault error'); }, processXml:soapProcess(() => {
      calls++;
      return '<ResponseXml><StatusCode>0</StatusCode><TransNo>0000000000013</TransNo><PinData><Pin>fixture</Pin></PinData></ResponseXml>';
    }) });
  assert.deepEqual(await failedVault.execute(account,pinPurchase),{ outcome:'UNCONFIRMED' });
  assert.equal(calls,2);
});

test('iPay last transaction is account-scoped and redacts the underlying voucher and provider secrets', async () => {
  const sdk = new IpaySdk({ ...base, allowedOperations:['lastTransaction'],processXml:soapProcess(body => {
    assert.match(body,/&lt;Type&gt;GetLastTrans&lt;\/Type&gt;/);
    return '<ResponseXml><StatusCode>0</StatusCode><Amount>9007199254740993.0400</Amount><ProductCode>FX0001</ProductCode>' +
      '<QortexStatus>P</QortexStatus><AuthorizationCode>fixture-private</AuthorizationCode><PinData><Pin>fixture-issued-secret</Pin></PinData></ResponseXml>';
  }) });
  await assert.rejects(sdk.execute({ ...account,tenantId:account.providerAccountId },{ operation:'lastTransaction' }),{ code:'SCOPE_DENIED' });
  assert.deepEqual(await sdk.execute(account,{ operation:'lastTransaction' }),
    { outcome:'OBSERVED',productCode:'FX0001',amount:'9007199254740993.0400',providerStatus:'P' });
});

test('iPay pins eCash transfer and cash collection forms and binds confirmation to the stored first step', async () => {
  const transfer = { operation:'ecashTransfer', reference:'transfer-fixture', receiptNumber:'00001',
    recipientMerchantId:'000337', amount:'18.50' } as const;
  const collection = { operation:'ecashCashCollection', reference:'collection-fixture', receiptNumber:'00001',
    payerMerchantId:'000553', amount:'18.50', collectionDescription:'Cash & credit record' } as const;
  const transferConfirm = { ...transfer, operation:'ecashTransferConfirm', firstTransactionNumber:'0000000000111' } as const;
  const collectionConfirm = { ...collection, operation:'ecashCashCollectionConfirm', firstTransactionNumber:'0000000000222' } as const;
  const cases = [
    [transfer,transferConfirm,'PinlessRequest','EFECSH','000337',''],
    [collection,collectionConfirm,'Pinlessrequest','TSTECA','000553',
      '<TerminalParameter>Cash &amp; credit record</TerminalParameter>'],
  ] as const;
  for (const [startRequest, confirmation, initialType, code, merchantId, description] of cases) {
    let wireCalls = 0;
    let previousFields: Readonly<Record<string,string>> | undefined;
    let confirmed = false;
    const processXml = soapProcess(body => {
      const type = ++wireCalls === 1 ? initialType : 'PinlessRequest2ndStep';
      assert.ok(body.includes(encodeIpayXmlText(`<Type>${type}</Type>`)));
      assert.ok(body.includes(encodeIpayXmlText(`<ProdCode>${code}</ProdCode><TransRef>${merchantId}</TransRef>${description}<Amount>18.50</Amount>`)));
      assert.doesNotMatch(body,/ChequeInfo|CardData|AccountNo/);
      return `<ResponseXml><StatusCode>0</StatusCode><TransNo>${confirmation.firstTransactionNumber}</TransNo><AuthorizationCode/></ResponseXml>`;
    });
    const sdk = new IpaySdk({ ...base, processXml, allowedOperations:[startRequest.operation,confirmation.operation],
      ecashTransferProduct:'EFECSH', ecashCashCollection:{productCode:'TSTECA',requestType:'Pinlessrequest'},
      reserveMutation:async (_account,intent) => {
        if (intent.operation === startRequest.operation) { previousFields = intent.fields; return true; }
        if (!previousFields || confirmed || intent.firstTransactionNumber !== confirmation.firstTransactionNumber ||
          JSON.stringify(previousFields) !== JSON.stringify(intent.fields)) return false;
        confirmed = true;
        return true;
    } });
    await assert.rejects(sdk.execute(account,confirmation),{code:'SCOPE_DENIED'});
    assert.deepEqual(await sdk.execute(account,startRequest),{outcome:'OBSERVED',phase:'CONFIRMATION_REQUIRED',
      reference:startRequest.reference,transactionNumber:confirmation.firstTransactionNumber});
    await assert.rejects(sdk.execute(account,{ ...confirmation,amount:'18.51' }),{code:'SCOPE_DENIED'});
    assert.deepEqual(await sdk.execute(account,confirmation),{outcome:'OBSERVED',phase:'ACKNOWLEDGED',
      reference:startRequest.reference,transactionNumber:confirmation.firstTransactionNumber});
    await assert.rejects(sdk.execute(account,confirmation),{code:'SCOPE_DENIED'});
    assert.equal(wireCalls,2);
  }
  const never = async () => assert.fail('Unconfigured money movement cannot send');
  assert.throws(() => new IpaySdk({ ...base,processXml:never, reserveMutation:never,allowedOperations:['ecashTransfer'] }),
    {code:'INVALID_CONFIGURATION'});
  assert.throws(() => new IpaySdk({ ...base,processXml:never, reserveMutation:never,allowedOperations:['ecashCashCollection'],
    ecashCashCollection:{productCode:'TSTECC',requestType:'PinlessRequest'} }), {code:'INVALID_CONFIGURATION'});
});

test('iPay cheque collection binds the nested cheque fields to the first observation before confirming', async () => {
  const collection = { operation:'ecashChequeCollection', reference:'cheque-fixture', receiptNumber:'00001', payerMerchantId:'000553',
    amount:'18.50', collectionDescription:'Fixture cheque', chequeNumber:'0005011', chequeDate:'2024-02-29', chequeBankName:'Fixture & Bank' } as const;
  const confirmCheque = { ...collection, operation:'ecashChequeCollectionConfirm', firstTransactionNumber:'0000000000222' } as const;
  let called = 0;
  let held: string | undefined;
  let confirmed = false;
  const sdk = new IpaySdk({ ...base,allowedOperations:['ecashChequeCollection','ecashChequeCollectionConfirm'],
    ecashChequeCollection:{ productCode:'TSTECC',requestType:'PinlessRequest' },
    reserveMutation:async (_account,intent) => {
      assert.ok(Object.isFrozen(intent.cheque));
      const payload = JSON.stringify([intent.fields,intent.cheque]);
      if (intent.operation === 'ecashChequeCollection') { held = payload; return true; }
      if (confirmed || intent.firstTransactionNumber !== confirmCheque.firstTransactionNumber || held !== payload) return false;
      confirmed = true; return true;
    },processXml:soapProcess(body => {
      const type = ++called === 1 ? 'PinlessRequest' : 'PinlessRequest2ndStep';
      assert.ok(body.includes(encodeIpayXmlText(`<Type>${type}</Type>`)));
      assert.ok(body.includes(encodeIpayXmlText('<ChequeInfo><ChequeNo>0005011</ChequeNo><ChequeDate>2024-02-29</ChequeDate>' +
        '<ChequeBankName>Fixture &amp; Bank</ChequeBankName></ChequeInfo>')));
      return '<ResponseXml><StatusCode>0</StatusCode><TransNo>0000000000222</TransNo><AuthorizationCode/></ResponseXml>';
    }) });
  await assert.rejects(sdk.execute(account,{ ...collection,chequeDate:'2026-02-29' }),{ code:'INVALID_REQUEST' });
  await assert.rejects(sdk.execute(account,confirmCheque),{ code:'SCOPE_DENIED' });
  assert.deepEqual(await sdk.execute(account,collection),{ outcome:'OBSERVED',phase:'CONFIRMATION_REQUIRED',reference:collection.reference,
    transactionNumber:confirmCheque.firstTransactionNumber });
  await assert.rejects(sdk.execute(account,{ ...confirmCheque,chequeNumber:'0005012' }),{ code:'SCOPE_DENIED' });
  assert.deepEqual(await sdk.execute(account,confirmCheque),{ outcome:'OBSERVED',phase:'ACKNOWLEDGED',reference:collection.reference,
    transactionNumber:confirmCheque.firstTransactionNumber });
  assert.equal(called,2);
});

test('iPay terminal password changes reserve one attempt and record only the acknowledged rotation ID', async () => {
  const rotationId = '00000000-0000-4000-8000-000000000004';
  const currentPassword = 'fixture<&old', newPassword = '00097531';
  const reservation = { ...account,rotationId,terminalId:'fixture-terminal',currentPassword,newPassword };
  let reserves = 0, sends = 0, records = 0;
  const rotate = createIpayPasswordRotation({ account,
    reserveRotation:async (scope,id) => { assert.deepEqual(scope,account); assert.equal(id,rotationId); return ++reserves === 1 ? reservation : undefined; },
    recordAcknowledgement:async (scope,id) => { records++; assert.deepEqual(scope,account); assert.equal(id,rotationId); return true; },
    processXml:soapProcess(body => {
      sends++;
      assert.ok(body.includes(encodeIpayXmlText('<Type>ChangeStPass</Type><TerminalId>fixture-terminal</TerminalId>' +
        `<Password>fixture&lt;&amp;old</Password><NewPassword>${newPassword}</NewPassword>`)));
      return '<ResponseXml><StatusCode>0</StatusCode></ResponseXml>';
    }) });
  await assert.rejects(rotate({ ...account,tenantId:account.providerAccountId },rotationId),{ code:'SCOPE_DENIED' });
  await assert.rejects(rotate(account,'invalid'),{ code:'INVALID_REQUEST' });
  assert.equal(reserves,0);
  assert.deepEqual(await rotate(account,rotationId),{ outcome:'RECORDED',rotationId });
  await assert.rejects(rotate(account,rotationId),{ code:'SCOPE_DENIED' });
  assert.equal(sends,1);
  assert.equal(records,1);
  const uncertain = createIpayPasswordRotation({ account,reserveRotation:async () => reservation,
    recordAcknowledgement:async () => assert.fail('An uncertain response cannot activate a new password'),
    processXml:async () => { throw new Error('fixture private transport failure'); } });
  assert.deepEqual(await uncertain(account,rotationId),{ outcome:'UNCONFIRMED' });
});
