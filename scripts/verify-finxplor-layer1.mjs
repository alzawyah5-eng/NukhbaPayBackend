import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  FinxplorCatalogue, finxplorCatalogueCostEvidence, finxplorExactFields,
} from '../packages/provider-adapters/src/finxplor-catalogue.ts';
import { readCatalogueJson, wireNumber } from '../packages/provider-adapters/src/catalogue-http.ts';

const origin = 'https://sandbox.finxplorconnect.com';
const sampleIds = ['1002_1643', '1002_20249'];
const monetaryFields = ['minAmount','maxAmount','faceValue','fixedValue','denominations','quick_select_denominations',
  'retailPrice','price','senderCost','walletDebit','acquisitionCost','cost','amount','settlementAmount',
  'additionalFee','fee','discount','commission','currency','settlementCurrency','walletCurrency'];
const expiryFields = ['usage','usageType','expiration','validity','validity_days','validityDays','validUntil',
  'pin_validity','plan_type','countryCode','deliveryMethod'];
const exactFields = new Set([...finxplorExactFields,...monetaryFields,'validity_days','validityDays']);
const knownIdentifiers = ['productId','offerId','offerVersionId','sku'];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const scalar = value => {
  const numeric = wireNumber(value);
  if (numeric !== undefined) return numeric;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:+-]{0,79}$/.test(value) ? value : undefined;
};

const monetaryScalar = value => {
  const exact=scalar(value);
  return typeof exact==='string' && (/^[A-Z]{3}$/.test(exact) || /^-?\d+(?:\.\d+)?$/.test(exact)) ? exact : undefined;
};

function monetary(row) {
  return Object.fromEntries(monetaryFields.flatMap(key=>{
    if (!row || !Object.hasOwn(row,key)) return [];
    const value = row[key];
    if (Array.isArray(value)) return [[key,value.slice(0,128).map(monetaryScalar).filter(x=>x!==undefined)]];
    const exact = monetaryScalar(value);
    return [[key, exact ?? 'PRESENT_FORMAT_NOT_PROJECTED']];
  }));
}

function restrictions(row) {
  const values = Object.fromEntries(expiryFields.flatMap(key=>{
    const exact = scalar(row?.[key]);
    return exact === undefined ? [] : [[key,exact]];
  }));
  return {
    ...values,
    providerTermsPresent: Boolean(row?.termsUrl || row?.redemption_instructions || row?.redemptionInfo),
    quoteExpiry: null,
  };
}

export async function verifyFinxplorLayer1({account,reference,apiKey,database}) {
  const registration=/^finxplor\/sandbox\/registration-(\d{1,30})$/.exec(reference)?.[1];
  if(!registration || database?.read_only!==true || database.major!==18 ||
      database.account_status!=='DISABLED') throw new Error('Read-only verification scope unavailable');
  const accountReference = 'sandbox-registration:'+registration;
  const observations = new Map();
  const capture = async (url, init) => {
    const endpoint = new URL(url);
    const allowed = endpoint.origin === origin && (endpoint.pathname === '/api/v1/products'
      ? /^page=[12]&limit=20$/.test(endpoint.search.slice(1))
      : /^\/api\/v1\/products\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(endpoint.pathname) && !endpoint.search);
    if (!allowed || init.method !== 'GET' || init.redirect !== 'error') throw new Error('Verification operation denied');
    const response = await fetch(url,init);
    const evidence = {endpoint:endpoint.pathname+endpoint.search,retrievedAt:new Date().toISOString(),httpStatus:response.status};
    observations.set(evidence.endpoint,evidence);
    if (response.status === 200) {
      const body = await readCatalogueJson(response.clone(),init.signal,exactFields,()=>new Error('Cannot project response'));
      if (endpoint.pathname === '/api/v1/products') {
        const rows = Array.isArray(body.data) ? body.data : [];
        evidence.productIds = rows.map(r=>r?.productId).filter(v=>typeof v==='string'&&idPattern.test(v));
        evidence.rows = rows.length;
        evidence.reported = {
          page:body.pagination?.page, limit:body.pagination?.limit, total:body.pagination?.total,
          totalPages:body.pagination?.totalPages, hasNextPage:body.pagination?.hasNextPage,
        };
        evidence.samples = rows.filter(r=>typeof r?.productId==='string' && idPattern.test(r.productId)).slice(0,20)
          .map(r=>({id:r.productId,country:scalar(r.countryCode),category:scalar(r.category),
            endpoint:evidence.endpoint,retrievedAt:evidence.retrievedAt,
            monetaryFields:monetary(r),restrictions:restrictions(r)}));
      } else {
        const row = body.data?.product;
        evidence.monetary = monetary(row);
        evidence.identifiers = Object.fromEntries(knownIdentifiers.flatMap(k=>{
          const v=row?.[k];
          return typeof v==='string' && idPattern.test(v) ? [[k,v]] : [];
        }));
        evidence.restrictions = restrictions(row);
      }
    }
    return response;
  };
  const adapter = new FinxplorCatalogue({account,credentialReference:reference,getApiKey:async()=>apiKey,transport:capture});
  const signal = AbortSignal.timeout(120_000);
  const pages = [];
  for (const page of [1,2]) {
    let adapterAccepted = false;
    try { await adapter.page(account,page,20,signal); adapterAccepted=true; } catch {}
    const observation = observations.get('/api/v1/products?page='+page+'&limit=20') ?? {httpStatus:null};
    pages.push({...observation,page,adapterAccepted});
    await delay(1250,undefined,{signal});
  }
  const ids=pages.flatMap(page=>page.productIds??[]);
  const sampleCandidates=pages.flatMap(page=>page.samples??[]);
  const selected=new Set(sampleIds);
  const represented = new Set();
  for (const item of sampleCandidates) {
    if (selected.size>=6) break;
    const key=item.category+':'+item.country;
    if (!represented.has(key)) {
      represented.add(key);
      selected.add(item.id);
    }
  }
  const details=[];
  for (const id of selected) {
    const endpoint = '/api/v1/products/'+encodeURIComponent(id);
    let product;
    try { product = await adapter.detail(account,id,signal,'ARE_GIFT_CARD'); } catch {}
    const observed = observations.get(endpoint);
    const listed = sampleCandidates.find(item=>item.id===id);
    details.push({
      productId:id, offerId:observed?.identifiers?.offerId??null, offerVersionId:observed?.identifiers?.offerVersionId??null,
      endpoint,retrievedAt:observed?.retrievedAt??null,httpStatus:observed?.httpStatus??null,
      adapterAccepted:Boolean(product),accountReference,
      ...(listed && {catalogueObservation:listed}),
      ...(product && {country:product.country,productType:product.category,delivery:product.delivery,usage:product.usage,
        faceCurrency:product.currency,faceValues:product.denominations,minFaceValue:product.minAmount,maxFaceValue:product.maxAmount,
        acquisition:finxplorCatalogueCostEvidence(product),monetaryFields:observed?.monetary,restrictions:observed?.restrictions,
        verifiedAcquisitionAmount:null,verifiedSettlementCurrency:null,verifiedFeeAndCommissionTreatment:null}),
      ...(!product && listed && {
        acquisition:{basis:'QUOTE_REQUIRED',sourceReference:id},
        verifiedAcquisitionAmount:null,verifiedSettlementCurrency:null,verifiedFeeAndCommissionTreatment:null,
      }),
    });
    if (!signal.aborted) await delay(1250,undefined,{signal});
  }
  const name = 'finxplor-layer1-verification-'+randomUUID()+'.json';
  const report={
    schemaVersion:1,environment:'SANDBOX',hostname:new URL(origin).hostname,scope:accountReference,database,
    verifyStartedFrom:'approved catalogue credentials',retrievedAt:new Date().toISOString(),catalogueCompleteness:'PARTIAL',
    requestedPages:[1,2],requestedPageSize:20,observedHttp200Pages:pages.filter(p=>p.httpStatus===200).length,
    observedRows:pages.reduce((sum,p)=>sum+(p.rows??0),0),uniqueProductIds:new Set(ids).size,
    duplicateProductIds:ids.length-new Set(ids).size, invalidProductIdCount:pages.reduce((sum,p)=>sum+(p.rows??0),0)-ids.length,
    pages:pages.map(({samples,...p})=>p),details,
    commercialEndpoint:'NO_DOCUMENTED_PERMITTED_PRODUCT_QUOTE',
  };
  await writeFile(new URL('../.local/'+name,import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({receipt:'.local/'+name,environment:report.environment,hostname:report.hostname,
    scope:report.scope,database,observedHttp200Pages:report.observedHttp200Pages,observedRows:report.observedRows,
    uniqueProductIds:report.uniqueProductIds,duplicateProductIds:report.duplicateProductIds,
    catalogueCompleteness:report.catalogueCompleteness,acceptedDetails:details.filter(d=>d.adapterAccepted).length}));
  if (!report.observedHttp200Pages || !details.some(d=>d.adapterAccepted)) process.exitCode=1;
}
