import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
export function createManualCatalogueSync(expectedTenant) {
 let running=false;
 return async tenantId=>{
  if(tenantId!==expectedTenant || running)throw new Error('Catalogue sync unavailable');
  running=true;
  const started=Date.now();
  try {
   await execute('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','RemoteSigned',
    '-File',fileURLToPath(new URL('./setup-windows-catalogue.ps1',import.meta.url)),'-ForStartup'],
    {cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,timeout:60000,maxBuffer:16384});
   await execute('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','RemoteSigned',
    '-File',fileURLToPath(new URL('./setup-windows-catalogue.ps1',import.meta.url)),'-Global'],
    {cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,timeout:660000,maxBuffer:16384});
   const directory=new URL('../.local/finxplor-refresh/',import.meta.url);
   const names=await readdir(directory);
   for(const name of names.reverse()) {
    if(!/^[a-f0-9]{32}-[a-z-]+\.json$/.test(name))continue;
    const receipt=JSON.parse(await readFile(new URL(name,directory),'utf8'));
    const complete = receipt.state==='COMMITTED' && receipt.completedCoverage==='ALL_COUNTRIES';
    const partial = receipt.state==='PARTIAL_COMMITTED' && receipt.storedCoverage==='PARTIAL_ALL_COUNTRIES';
    if(Date.parse(receipt.timeUtc)>=started && (complete||partial) && receipt.persisted===true) {
      const counts = {products:receipt.products,inserted:receipt.inserted,unchanged:receipt.unchanged,
        ...(partial && {nextPage:receipt.nextPage,verificationPending:receipt.verificationPending===true,verificationMismatch:receipt.verificationMismatch===true})};
      try {
        const {stdout} = await runCatalogueOperation('-RefreshFinxplorPrices',60_000);
        const prices = JSON.parse(stdout.trim());
        if (prices?.result==='STORED' && Number.isSafeInteger(prices.rows) && Number.isSafeInteger(prices.awaiting_fx)) {
          return {...counts,layer1:{amounts:prices.rows,pendingFx:prices.awaiting_fx}};
        }
      } catch {
        // Catalogue is already committed; pricing can retry independently.
      }
      return {...counts,layer1:null};
    }
   }
   throw new Error('Sync persistence could not be verified');
  } finally {running=false;}
 };
}

function runCatalogueOperation(operation,timeout) {
  return execute('powershell.exe', [
    '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','RemoteSigned',
    '-File',fileURLToPath(new URL('./setup-windows-catalogue.ps1',import.meta.url)),operation,
  ],{cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,timeout,maxBuffer:8192});
}

export function createManualIpaySync(expectedTenant) {
  return async tenantId => {
    if (tenantId !== expectedTenant) throw new Error('iPay catalogue sync unavailable');
    const { stdout } = await runCatalogueOperation('-SyncIpay', 40_000);
    const { products, inserted, unchanged, persisted } = JSON.parse(stdout.trim());
    if (persisted !== true || ![products, inserted, unchanged].every(count => Number.isSafeInteger(count) && count >= 0) ||
        products === 0 || inserted + unchanged !== products) throw new Error('iPay catalogue sync unconfirmed');
    return { products, inserted, unchanged };
  };
}

export function createManualFxRefresh(expectedTenant) {
  return async tenantId => {
    if (tenantId !== expectedTenant) throw new Error('Exchange-rate refresh unavailable');
    const {stdout} = await runCatalogueOperation('-RefreshFinxplorPricesNow',420_000);
    const result = JSON.parse(stdout.trim());
    if (result?.result === 'FX_NOT_CONFIGURED') return {status:'not-configured'};
    if (result?.result === 'ALREADY_RUNNING') return {status:'already-running'};
    const {rateRows,fx_converted,awaiting_fx,failedCurrencies} = result ?? {};
    if (result?.result !== 'STORED' || ![rateRows,fx_converted,awaiting_fx,failedCurrencies]
      .every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Exchange-rate refresh unconfirmed');
    return {status:'completed',ratesFetched:rateRows,converted:fx_converted,pending:awaiting_fx,failedCurrencies};
  };
}
