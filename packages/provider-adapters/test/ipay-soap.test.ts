import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpaySoapProcess, IpaySdk } from '../src/ipay-sdk.ts';
import { decodeIpayProductFile, encodeIpayXmlText } from '../src/ipay-soap.ts';

const account = { tenantId: '00000000-0000-4000-8000-000000000001', providerAccountId: '00000000-0000-4000-8000-000000000002' };
const soap = 'http://schemas.xmlsoap.org/soap/envelope/';
const namespace = 'urn:fixture:ipay:process';
const binding = { endpoint: 'https://ipay.fixture.invalid/ecsoap', namespace, action: 'urn:fixture:ipay:process:Process',
  requestElementNamespace: '', resultElement: 'ProcessResult', resultElementNamespace: namespace };
const responseXml = '<ResponseXml><StatusCode>0</StatusCode><Balance>9007199254740993.0700</Balance>' +
  '<PinData><Pin>fixture-sensitive-value</Pin></PinData></ResponseXml>';
const wrap = (payload: string) => `<s:Envelope xmlns:s="${soap}"><s:Body><ProcessResponse xmlns="${namespace}">` +
  `<ProcessResult>${encodeIpayXmlText(payload)}</ProcessResult></ProcessResponse></s:Body></s:Envelope>`;
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
const signal = () => new AbortController().signal;

test('iPay posts a namespace-bound SOAP 1.1 Process request with escaped inner XML', async () => {
  let calls = 0;
  const transport = createIpaySoapProcess({ ...binding, transport: async (url, init) => {
    calls++;
    assert.equal(url, binding.endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('SOAPAction'), `"${binding.action}"`);
    assert.equal(headers.get('Content-Type'),'text/xml; charset=utf-8');
    const inner = '<RequestXml><Type>GetBalanceSt</Type><TerminalId>fixture</TerminalId><Password>x&lt;&amp;y</Password></RequestXml>';
    assert.equal(init.body, `<soap:Envelope xmlns:soap="${soap}"><soap:Body><Process xmlns="${namespace}">` +
      `<RequestXml xmlns="">${encodeIpayXmlText(inner)}</RequestXml></Process></soap:Body></soap:Envelope>`);
    return xml(wrap(responseXml));
  } });
  const sdk = new IpaySdk({ account, allowedOperations: ['balance'],
    getCredentials: async () => ({ terminalId: 'fixture', password: 'x<&y' }), processXml: transport });
  assert.deepEqual(await sdk.execute(account,{ operation: 'balance' }), { outcome: 'OBSERVED', balance: '9007199254740993.0700' });
  assert.equal(calls, 1);
});

test('iPay rejects SOAP and inner XML ambiguity without a second provider request', async () => {
  const payloads = [
    xml(wrap(responseXml).replace(namespace,'urn:foreign:process')),
    xml(wrap(responseXml).replace('ProcessResult','IncorrectResult')),
    xml(wrap(responseXml.replace('</ResponseXml>','<Balance>25</Balance></ResponseXml>'))),
    xml(wrap(responseXml.replace('9007199254740993.0700','<Invalid/>'))),
    xml(wrap('<!DOCTYPE ResponseXml SYSTEM "file:///private"><ResponseXml><Balance>0</Balance></ResponseXml>')),
    xml('<?external fixture?>' + wrap(responseXml)),
    xml(`<s:Envelope xmlns:s="${soap}"><s:Body><s:Fault/></s:Body></s:Envelope>`),
    xml(wrap(responseXml),500),
    new Response(wrap(responseXml), { headers: { 'content-type':'application/json' } }),
    new Response(wrap(responseXml), { headers: { 'content-type':'text/xml', 'content-length':'3000000' } }),
    Response.redirect('https://foreign.fixture.invalid/ecsoap'),
  ];
  let calls = 0;
  const process = createIpaySoapProcess({ ...binding, transport: async () => payloads[calls++]! });
  for (const _ of payloads) await assert.rejects(process('<RequestXml><Type>Version</Type></RequestXml>',signal()), /could not be verified/);
  assert.equal(calls,payloads.length);
  await assert.rejects(process('<!DOCTYPE RequestXml><RequestXml/>',signal()), /could not be verified/);
  assert.equal(calls,payloads.length);
  for (const endpoint of ['http://ipay.fixture.invalid/ecsoap', `${binding.endpoint}?credential=fixture`, 'https://ipay.fixture.invalid/Web/Get'])
    assert.throws(() => createIpaySoapProcess({ ...binding, endpoint, transport: async () => assert.fail() }), /could not be verified/);
});

test('iPay requests only the assigned product XML file and projects exact products while discarding templates', async () => {
  // The fixture root is a configuration value. Confirm the vendor's actual root during qualification.
  const catalogue = '<FixtureProductFile GroupNumber="0006" ProductVersion="0037">' +
    '<Category Name="Mobile" Products="2"><Product Name="Fixture fixed PIN" ProductCode="FIN001" StoreGUI="EP" AmountLimit="0" Amounts="1">' +
    '<Amount Value="25.0100" UpcNumber="00123456789" Display="Fixture display"/><VoucherTemplate>discard this</VoucherTemplate></Product>' +
    '<Product Name="Fixture variable top-up" ProductCode="FIN002" StoreGUI="TV" AmountLimit="99.9900"/>' +
    '</Category></FixtureProductFile>';
  const makePayload = (source: string) => `<ResponseXml><StatusCode>0</StatusCode><ProductVer>0037</ProductVer>` +
    `<FileData>${encodeIpayXmlText(source)}</FileData></ResponseXml>`;
  let documents = [catalogue, catalogue.replace('0006','0007'), catalogue.replace('0037','0038'),
    catalogue.replace('Products="2"','Products="1"'), catalogue.replace('FIN002','FIN001')];
  let calls = 0;
  const process = createIpaySoapProcess({ ...binding, transport: async (_url, init) => {
    calls++;
    assert.match(String(init?.body), /&lt;Type&gt;FileDownload&lt;\/Type&gt;/);
    assert.match(String(init?.body), /&lt;FileType&gt;1&lt;\/FileType&gt;/);
    assert.doesNotMatch(String(init?.body), /OrderNo|Invoice/);
    return xml(wrap(makePayload(documents.shift()!)));
  } });
  const sdk = new IpaySdk({ account, allowedOperations: ['productFile'], productFile: { rootElement: 'FixtureProductFile', groupNumber: '0006' },
    getCredentials: async () => ({ terminalId: 'fixture', password: 'fixture-pass' }), processXml: process });
  assert.deepEqual(await sdk.execute(account,{ operation:'productFile' }), { outcome:'OBSERVED', catalogue:{ version:'0037', groupNumber:'0006', products:[
    { code:'FIN001', title:'Fixture fixed PIN', category:'Mobile', sourceType:'EP', amountLimit:'0', amounts:[{ value:'25.0100', upc:'00123456789' }] },
    { code:'FIN002', title:'Fixture variable top-up', category:'Mobile', sourceType:'TV', amountLimit:'99.9900', amounts:[] },
  ] } });
  while (documents.length) assert.deepEqual(await sdk.execute(account,{ operation:'productFile' }), { outcome:'UNCONFIRMED' });
  assert.equal(calls,5);
});

test('iPay PIN checks use the configured case and require the documented positive status pair', async () => {
  const replies = [['0','Pin is available'],['0','Other response'],['1','Pin is available']];
  const process = createIpaySoapProcess({ ...binding, transport: async (_url, init) => {
    assert.match(String(init?.body), /&lt;Type&gt;pinavlb&lt;\/Type&gt;/);
    assert.match(String(init?.body), /&lt;ProdCode&gt;FIN001&lt;\/ProdCode&gt;&lt;Amount&gt;12\.3400&lt;\/Amount&gt;/);
    const [code,message] = replies.shift()!;
    return xml(wrap(`<ResponseXml><StatusCode>${code}</StatusCode><StatusDescription>${message}</StatusDescription></ResponseXml>`));
  } });
  const options = { account, allowedOperations: ['pinAvailability'] as const,
    getCredentials: async () => ({ terminalId:'fixture', password:'fixture-pass' }), processXml: process };
  assert.throws(() => new IpaySdk(options), { code:'INVALID_CONFIGURATION' });
  const sdk = new IpaySdk({ ...options,pinAvailabilityType:'pinavlb' });
  const request = { operation:'pinAvailability', productCode:'FIN001', amount:'12.3400' } as const;
  await assert.rejects(sdk.execute(account,{ ...request,amount:'12.34001' }), { code:'INVALID_REQUEST' });
  assert.deepEqual(await sdk.execute(account,request), { outcome:'OBSERVED', available:true });
  assert.deepEqual(await sdk.execute(account,request), { outcome:'UNCONFIRMED' });
  assert.deepEqual(await sdk.execute(account,request), { outcome:'UNCONFIRMED' });
});

test('iPay projects the qualified Qore3 file format with exact denominations and no price inferred from Display', () => {
  const document = '<![CDATA[<?xml version="1.0"?>' +
    '<ProductFile><GroupNumber>003</GroupNumber><ProductVersion>0009</ProductVersion><NumberOfCategories>1</NumberOfCategories>' +
    '<Category Name="Fixture catalogue" Products="2">' +
    '<Product ProductCode="TST001" Name="Fixture PIN" StoreGUI="EP" CurrencyCode="AED" Amounts="1">' +
    '<Amount Value="25.0100" Display="AED 30"/></Product>' +
    '<Product ProductCode="TST002" Name="Fixture top-up" StoreGUI="TT" CurrencyCode="AED" Amounts="1">' +
    '<Amount Value="0" Display="AED .00"/></Product></Category></ProductFile>]]>';
  const profile = {rootElement:'ProductFile',groupNumber:'003',format:'qore3-product-file'} as const;
  assert.deepEqual(decodeIpayProductFile(document,profile,'0030009'),{
    version:'0030009',groupNumber:'003',products:[
      {code:'TST001',title:'Fixture PIN',category:'Fixture catalogue',sourceType:'EP',currency:'AED',amountLimit:'0',amounts:[{value:'25.0100'}]},
      {code:'TST002',title:'Fixture top-up',category:'Fixture catalogue',sourceType:'TT',currency:'AED',amountLimit:'0',amounts:[]},
    ],
  });
  assert.throws(() => decodeIpayProductFile(document,profile,'0030010'));
  for (const invalid of [
    document.replace('003</GroupNumber>','004</GroupNumber>'),
    document.replace('<GroupNumber>003</GroupNumber>','<GroupNumber>003</GroupNumber><GroupNumber>003</GroupNumber>'),
    document.replace('<NumberOfCategories>1','<NumberOfCategories>2'),
    document.replace('CurrencyCode="AED"','CurrencyCode="AEDX"'),
    document.replace('StoreGUI="TT"','StoreGUI="EP"'),
    document.replace('<ProductFile>','<!DOCTYPE ProductFile><ProductFile>'),
  ]) assert.throws(() => decodeIpayProductFile(invalid,profile,'0030009'));
});
