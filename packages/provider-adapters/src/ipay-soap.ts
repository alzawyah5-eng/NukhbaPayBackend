import { SaxesParser } from 'saxes';
import { readProviderText, withinCatalogueDeadline } from './catalogue-http.ts';

interface SoapBinding {
  /** Exact HTTPS endpoint for the approved account. */
  readonly endpoint: string;
  readonly namespace: string;
  readonly action: string;
  readonly requestElementNamespace: string;
  readonly resultElement: string;
  readonly resultElementNamespace: string;
  readonly transport: typeof fetch;
}

interface Element {
  readonly local: string;
  readonly uri: string;
  readonly children: Element[];
  readonly attributes: Readonly<Record<string, string>>;
  text: string;
}

const soap = 'http://schemas.xmlsoap.org/soap/envelope/';
const entity: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const invalid = () => new Error('iPay SOAP request could not be verified');
const xmlName = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const namespace = /^[a-zA-Z][a-zA-Z0-9+.-]*:[!-~]{1,500}$/;
const responseFields = new Set(['Version','StatusCode','StatusDescription','Balance','ProductCode','TransNo','Amount','RefNo','AuthorizationCode',
  'ProductVer','FileData','QortexStatus','SptransStatus']);

const pinFields = Object.freeze({ Pin: 31, PinSerial: 80, PinBatch: 15, ExpiryDate: 10, Custom1: 80, Custom2: 33 });
export type IpayIssuedPin = Readonly<Partial<Record<keyof typeof pinFields, string>> & { Pin: string }>;
const issuedPins = new WeakMap<object, IpayIssuedPin>();

export function encodeIpayXmlText(text: string): string {
  return text.replace(/[&<>"']/g, character => entity[character]!);
}

function parseXml(input: string, allowAttributes = false): Element {
  const parser = new SaxesParser({ xmlns: true });
  const stack: Element[] = [];
  let root: Element | undefined;
  let nodes = 0;
  parser.on('doctype', () => { throw invalid(); });
  parser.on('processinginstruction', () => { throw invalid(); });
  parser.on('opentag', tag => {
    if (stack.length >= 24 || ++nodes > 15_000) throw invalid();
    const attributes: Record<string, string> = Object.create(null);
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === 'http://www.w3.org/2000/xmlns/') continue;
      if (!allowAttributes || attribute.uri !== '') throw invalid();
      attributes[attribute.local] = attribute.value;
    }
    const element: Element = { local: tag.local, uri: tag.uri, children: [], attributes, text: '' };
    const parent = stack.at(-1);
    if (parent) parent.children.push(element);
    else root = element;
    stack.push(element);
  });
  const addText = (value: string) => {
    const parent = stack.at(-1);
    if (parent) parent.text += value;
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(input).close();
  if (!root || stack.length) throw invalid();
  return root;
}

type ProductFileBinding = Readonly<{ rootElement: string; groupNumber: string }>;
const decimal = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,8})?$/;
const productCode = /^[A-Za-z0-9]{1,12}$/;
const displayText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' &&
  value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);

export function isIpayProductFileBinding(binding: ProductFileBinding): boolean {
  return typeof binding.rootElement === 'string' && xmlName.test(binding.rootElement) &&
    typeof binding.groupNumber === 'string' && /^\d{1,20}$/.test(binding.groupNumber);
}

/** Project the SDK's documented product fields. The assigned feed must confirm the root element. */
export function decodeIpayProductFile(input: unknown, binding: ProductFileBinding, version: unknown) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 2 * 1024 * 1024 ||
      typeof version !== 'string' || !/^\d{1,20}$/.test(version)) throw invalid();
  const root = parseXml(input,true);
  if (root.local !== binding.rootElement || root.uri !== '' || root.attributes['GroupNumber'] !== binding.groupNumber ||
      root.attributes['ProductVersion'] !== version) throw invalid();
  const products = [];
  const seen = new Set<string>();
  for (const group of root.children) {
    if (group.uri !== '' || group.local !== 'Category') continue;
    const name = group.attributes['Name'];
    const entries = group.children.filter(item => item.uri === '' && item.local === 'Product');
    if (!displayText(name) || group.attributes['Products'] !== String(entries.length)) throw invalid();
    for (const item of entries) {
      const { ProductCode: code, Name: title, StoreGUI: sourceType, AmountLimit: amountLimit, Amounts: count } = item.attributes;
      const amounts = item.children.filter(child => child.uri === '' && child.local === 'Amount');
      if (!code || !productCode.test(code) || seen.has(code) || !displayText(title) || !sourceType || !/^[A-Za-z0-9]{1,16}$/.test(sourceType) ||
          typeof amountLimit !== 'string' || !decimal.test(amountLimit) || amounts.length > 7 ||
          (count !== String(amounts.length) && !(count === undefined && sourceType === 'TV' && amounts.length === 0))) throw invalid();
      seen.add(code);
      const values = amounts.map(amount => {
        const value = amount.attributes['Value'], upc = amount.attributes['UpcNumber'];
        if (typeof value !== 'string' || !decimal.test(value) || !/[1-9]/.test(value) ||
            (upc !== undefined && !/^\d{1,18}$/.test(upc))) throw invalid();
        return Object.freeze({ value, ...(upc === undefined ? {} : { upc }) });
      });
      if (new Set(values.map(entry => entry.value.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'))).size !== values.length) throw invalid();
      products.push(Object.freeze({ code, title, category: name, sourceType, amountLimit, amounts: Object.freeze(values) }));
    }
  }
  if (!products.length) throw invalid();
  return Object.freeze({ version, groupNumber: binding.groupNumber, products: Object.freeze(products) });
}

function oneChild(parent: Element, local: string, uri: string): Element {
  const element = parent.children[0];
  if (parent.text.trim() || parent.children.length !== 1 || !element || element.local !== local || element.uri !== uri) throw invalid();
  return element;
}

function decodeResult(input: string, binding: Pick<SoapBinding,'namespace'|'resultElement'|'resultElementNamespace'>,
  pinPurchase: boolean) {
  const envelope = parseXml(input);
  if (envelope.local !== 'Envelope' || envelope.uri !== soap) throw invalid();
  const body = oneChild(envelope,'Body',soap);
  const response = oneChild(body,'ProcessResponse',binding.namespace);
  const result = oneChild(response,binding.resultElement,binding.resultElementNamespace);
  if (result.children.length) throw invalid();
  const payload = parseXml(result.text);
  if (payload.local !== 'ResponseXml' || payload.uri !== '' || payload.text.trim()) throw invalid();
  const fields: Record<string, string> = Object.create(null);
  for (const item of payload.children) {
    if (item.uri !== '' || !responseFields.has(item.local)) continue;
    if (item.children.length || Object.hasOwn(fields,item.local)) throw invalid();
    fields[item.local] = item.text;
  }
  const resultFields = Object.freeze(fields);
  if (pinPurchase && resultFields['StatusCode'] === '0') {
    const matches = payload.children.filter(item => item.uri === '' && item.local === 'PinData');
    if (matches.length !== 1 || matches[0]!.text.trim()) throw invalid();
    const pin: Partial<Record<keyof typeof pinFields, string>> = Object.create(null);
    for (const item of matches[0]!.children) {
      if (item.uri !== '' || !Object.hasOwn(pinFields, item.local)) continue;
      const field = item.local as keyof typeof pinFields;
      if (Object.hasOwn(pin, field) || item.children.length || item.text.length > pinFields[field] ||
          /[\x00-\x1f\x7f]/.test(item.text)) throw invalid();
      pin[field] = item.text;
    }
    if (!pin.Pin || !pin.Pin.trim()) throw invalid();
    issuedPins.set(resultFields, Object.freeze({ ...pin, Pin: pin.Pin }));
  }
  return resultFields;
}

/** Internal one-use transfer of the issued voucher into the backend's protected fulfilment store. */
export function takeIpayIssuedPin(response: object): IpayIssuedPin | undefined {
  const pin = issuedPins.get(response);
  issuedPins.delete(response);
  return pin;
}

/** SOAP 1.1 Process(String) transport. Namespace, action and result name are pinned to the approved WSDL. */
export function createIpaySoapProcess(options: SoapBinding) {
  const binding = Object.freeze({ ...options });
  const { endpoint, namespace: uri, action, requestElementNamespace, resultElementNamespace, resultElement, transport } = binding;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.pathname !== '/ecsoap' || endpoint !== url.origin + url.pathname ||
        typeof transport !== 'function' || !namespace.test(uri) || !namespace.test(action) || /["\\]/.test(action) ||
        (requestElementNamespace !== '' && !namespace.test(requestElementNamespace)) ||
        (resultElementNamespace !== '' && !namespace.test(resultElementNamespace)) || !xmlName.test(resultElement)) throw invalid();
  } catch { throw invalid(); }

  return async (requestXml: string, parent: AbortSignal) => {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
    try {
      signal.throwIfAborted();
      if (typeof requestXml !== 'string' || Buffer.byteLength(requestXml) > 32_768) throw invalid();
      const request = parseXml(requestXml);
      if (request.local !== 'RequestXml' || request.uri !== '') throw invalid();
      const types = request.children.filter(item => item.uri === '' && item.local === 'Type');
      if (types.length !== 1 || types[0]!.children.length || !types[0]!.text) throw invalid();
      const body = `<soap:Envelope xmlns:soap="${soap}"><soap:Body><Process xmlns="${encodeIpayXmlText(uri)}">` +
        `<RequestXml xmlns="${encodeIpayXmlText(requestElementNamespace)}">${encodeIpayXmlText(requestXml)}</RequestXml>` +
        '</Process></soap:Body></soap:Envelope>';
      const response = await withinCatalogueDeadline(() => transport(endpoint, { method: 'POST', body, signal,
        headers: { Accept: 'text/xml', 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
        redirect: 'error', cache: 'no-store', credentials: 'omit' }), signal);
      if (response.status !== 200 || response.redirected || (response.url && response.url !== endpoint)) {
        void response.body?.cancel().catch(() => undefined);
        throw invalid();
      }
      const raw = await readProviderText(response,signal,'text/xml',invalid);
      signal.throwIfAborted();
      return decodeResult(raw,binding,types[0]!.text === 'PinRequest');
    } catch { throw invalid(); }
  };
}
