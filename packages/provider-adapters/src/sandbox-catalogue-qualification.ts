import { IronGateCatalogue, type IronGateCatalogueOptions } from './irongate-catalogue.ts';
import { SslWirelessCatalogue, type SslWirelessCatalogueOptions } from './ssl-wireless-catalogue.ts';

type SslRead = 'service-list' | 'package-list';
type IronGateRead = keyof IronGateCatalogueOptions['successCodes'];
type Approval = Readonly<{
  environment: 'SANDBOX'; provider: 'SSL_WIRELESS' | 'IRONGATE'; origin: string;
  tenantId: string; providerAccountId: string; credentialReference: string;
  method: 'GET' | 'POST'; path: string; requestBudget: 1 | 2;
}>;
type SslApproval = Approval & Readonly<{ provider:'SSL_WIRELESS'; contract:SslWirelessCatalogueOptions['contract']; country:'BD';
  categories:readonly string[]; operators?:readonly string[]; subChannelId?:string }>;
type IronGateApproval = Approval & Readonly<{ provider:'IRONGATE'; contract:'irongate/prepaid-v2+postpaid/catalogue';
  successCode:string }> & Readonly<Pick<IronGateCatalogueOptions,
    'prepaidCurrency'|'prepaidStatus'|'postpaidStatus'|'postpaidProvince'|'gameCode'|'domesticEsimOperator'|'internationalEsimLanguage'>>;
type Result = Readonly<{ outcome: 'SCHEMA_ACCEPTED'; records: number; requests: number } |
  { outcome: 'SCOPE_DENIED' | 'READ_FAILED'; requests: number }>;
type Account = Readonly<{ tenantId: string; providerAccountId: string }>;
const equalValues = (a:readonly string[] = [],b:readonly string[] = []) =>
  Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every(value=>typeof value==='string' && b.includes(value)) &&
  new Set(a).size===a.length && new Set(b).size===b.length;

function authorize(approval: Approval, provider: Approval['provider'], baseUrl: string, account: Account,
  method: Approval['method'], path: string, fetcher: typeof fetch) {
  const { origin } = new URL(baseUrl);
  if (approval.environment !== 'SANDBOX' || approval.provider !== provider || approval.origin !== origin ||
      (baseUrl !== origin && baseUrl !== origin + '/') || !origin.startsWith('https://') ||
      approval.tenantId !== account.tenantId || approval.providerAccountId !== account.providerAccountId ||
      approval.method !== method || approval.path !== path || ![1,2].includes(approval.requestBudget) ||
      (method === 'POST' && approval.requestBudget !== 1) ||
      typeof approval.credentialReference !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(approval.credentialReference) ||
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') throw new Error('Catalogue sandbox scope denied');
  const {credentialReference, requestBudget}=approval;
  let requests = 0;
  const transport: typeof fetch = (input, init) => {
    if (typeof input !== 'string' || input !== origin + path || init?.method !== method ||
        init.redirect !== 'error' || init.credentials !== 'omit' || requests >= requestBudget)
      return Promise.reject(new Error('Catalogue sandbox scope denied'));
    requests++;
    return fetcher(input,init);
  };
  return { credentialReference, transport, requests:()=>requests };
}

/** Trusted backend entry point for one approved SSL read. It returns counts only. */
export async function qualifySslCatalogueRead(operation: SslRead,
  config: Omit<SslWirelessCatalogueOptions,'getCredentials'|'fetch'>, approval: SslApproval,
  resolve: (reference:string, account:Account, signal:AbortSignal)=>ReturnType<SslWirelessCatalogueOptions['getCredentials']>,
  transport: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<Result> {
  let scope: ReturnType<typeof authorize> | undefined;
  try {
    if ((operation!=='service-list' && operation!=='package-list') || approval.contract!==config.contract || approval.country!=='BD' ||
        !equalValues(approval.categories,config.allowedCategories) || !equalValues(approval.operators,config.allowedOperatorIds) ||
        approval.subChannelId!==config.subChannelId ||
        (operation==='package-list' && (config.contract!=='mobile-top-up/8.2.0' || !approval.operators?.length)))
      return Object.freeze({outcome:'SCOPE_DENIED',requests:0});
    const path=operation==='service-list' ? '/api/service-list' : '/api/vr/package-list';
    const allowed=authorize(approval,'SSL_WIRELESS',config.baseUrl,config.account,'GET',path,transport);
    scope=allowed;
    const adapter=new SslWirelessCatalogue({...config,fetch:allowed.transport,
      getCredentials:(account,abort)=>resolve(allowed.credentialReference,account,abort)});
    const records=operation==='service-list' ? (await adapter.listServices(config.account,signal)).categories.length :
      (await adapter.listTopUpPackages(config.account,signal)).packages.length;
    return Object.freeze({outcome:'SCHEMA_ACCEPTED',records,requests:allowed.requests()});
  } catch { return Object.freeze({outcome:scope ? 'READ_FAILED' : 'SCOPE_DENIED',requests:scope?.requests() ?? 0}); }
}

/** Trusted backend entry point for one approved IronGate catalogue POST. */
export async function qualifyIronGateCatalogueRead(operation: IronGateRead,
  config: Omit<IronGateCatalogueOptions,'getCredentials'|'fetch'>, approval: IronGateApproval,
  resolve: (reference:string, account:Account, signal:AbortSignal)=>ReturnType<IronGateCatalogueOptions['getCredentials']>,
  transport: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<Result> {
  let scope: ReturnType<typeof authorize> | undefined;
  try {
    const paths={prepaid:'/api/pricelist',postpaid:'/api/v1/bill/check',games:'/api/gamelist',
      gameFormat:'/api/game/format',gameServers:'/api/inquiry-game-server',
      esimIndonesia:`/api/esimlist/${config.domesticEsimOperator}`,esimInternational:'/api/esiminternationallist'};
    if (!Object.hasOwn(paths,operation) || approval.contract!=='irongate/prepaid-v2+postpaid/catalogue' ||
        !approval.successCode || approval.successCode!==config.successCodes[operation] ||
        (operation==='prepaid' && (approval.prepaidCurrency!==config.prepaidCurrency || approval.prepaidStatus!==config.prepaidStatus)) ||
        (operation==='postpaid' && (approval.postpaidStatus!==config.postpaidStatus || approval.postpaidProvince!==config.postpaidProvince)) ||
        ((operation==='gameFormat' || operation==='gameServers') && (!approval.gameCode || approval.gameCode!==config.gameCode)) ||
        (operation==='esimIndonesia' && approval.domesticEsimOperator!==config.domesticEsimOperator) ||
        (operation==='esimInternational' && approval.internationalEsimLanguage!==config.internationalEsimLanguage))
      return Object.freeze({outcome:'SCOPE_DENIED',requests:0});
    const allowed=authorize(approval,'IRONGATE',config.baseUrl,config.account,'POST',paths[operation],transport);
    scope=allowed;
    const adapter=new IronGateCatalogue({...config,fetch:allowed.transport,
      getCredentials:(account,abort)=>resolve(allowed.credentialReference,account,abort)});
    const reads={
      prepaid:async()=>(await adapter.listPrepaidPrices(config.account,signal)).data.length,
      postpaid:async()=>(await adapter.listPostpaidPrices(config.account,signal)).data.length,
      games:async()=>(await adapter.listGameCodes(config.account,signal)).data.length,
      gameFormat:async()=>{ await adapter.getGameFormat(config.account,signal); return 1; },
      gameServers:async()=>(await adapter.listGameServers(config.account,signal)).data.length,
      esimIndonesia:async()=>(await adapter.getIndonesiaEsimAvailability(config.account,signal)).data.observedCount,
      esimInternational:async()=>(await adapter.listInternationalEsimCoverage(config.account,signal)).data.length,
    };
    return Object.freeze({outcome:'SCHEMA_ACCEPTED',records:await reads[operation](),requests:allowed.requests()});
  } catch { return Object.freeze({outcome:scope ? 'READ_FAILED' : 'SCOPE_DENIED',requests:scope?.requests() ?? 0}); }
}
