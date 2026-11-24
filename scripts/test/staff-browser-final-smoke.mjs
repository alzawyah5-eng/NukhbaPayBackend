import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBrowserAssets, browserAsset } from '../../apps/admin-web/dist/browser-assets.js';

const executable=process.env.NUKHBA_TEST_BROWSER ??
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
assert.ok(path.isAbsolute(executable),'Use the absolute path of an installed Chromium-compatible browser');
const key='a'.repeat(43), cursor='b'.repeat(64);
const actor='00000000-0000-4000-8000-000000000001',tenant='00000000-0000-4000-8000-000000000002';
const requestId='00000000-0000-4000-8000-000000000003';

async function until(work, description, timeoutMs=10000) {
  const end=performance.now()+timeoutMs;
  let lastError;
  while (performance.now()<end) {
    try { const value=await work(); if (value) return value; }
    catch(error) {lastError=error;}
    await delay(80);
  }
  throw new Error(description,{cause:lastError});
}

test('existing React workspace completes catalogue loading and protected command forms in a Chromium browser',async()=>{
  const root=path.resolve('.local');
  await mkdir(root,{recursive:true});
  const assets=loadBrowserAssets(path.resolve('apps/admin-web/dist/client'));
  const profileRoot=await realpath(tmpdir());
  const profile=await mkdtemp(path.join(profileRoot,'staff-browser-final-'));
  const received=[];
  const groupQueries=new Set();
  const fixtureRequests=new Set();
  let command='STEP_UP_REQUIRED',reviewDecision,expired=false,privatePrice='permitted',releaseCountries,publicationAction;
  let loginEnabled=false,staffEnabled=true;
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    fixtureRequests.add(url.pathname);
    const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if (url.pathname==='/auth/workspace') {reply(expired?401:200,{csrfToken:key,staffId:actor,tenantId:tenant,expiresAtMs:Date.now()+60000,
      navigation:staffEnabled?['/overview','/staff','/audit','/catalogue','/staff/commands','/catalogue/publication']:['/overview']});return;}
    if (url.pathname==='/auth/config') {reply(200,{loginPath:loginEnabled?'/auth/login':null});return;}
    if (url.pathname==='/auth/login') {reply(200,{surface:'fixture login handoff'});return;}
    if (url.pathname==='/staff-api/staff' || url.pathname==='/staff-api/staff/'+actor) {
      reply(staffEnabled?200:403,{items:[{id:actor,status:'ACTIVE',membershipStatus:'ACTIVE',version:'1',roles:['SUPPORT_AGENT']}],next:null});return;
    }
    if (url.pathname==='/staff-api/audit') {
      reply(staffEnabled?200:403,{items:[{id:requestId,occurredAt:'2026-11-21T10:00:00Z',action:'AUTHORIZATION_DECISION',outcome:'SUCCESS',actorStaffId:actor}],next:null});return;
    }
    if (url.pathname.startsWith('/staff-api/catalogue/')) {
      const view=url.pathname.split('/').pop();
      const page=(items=[],next=null)=>reply(200,{revision:'browser-v1',items,next});
      if (view==='countries') {
        groupQueries.add(url.searchParams.get('group'));
        if(url.searchParams.get('group')==='EUROPE') {page([{id:'DE',name:'Germany',configured:false}]);return;}
        const replyCountries=()=>page([{id:'AE',name:'United Arab Emirates',configured:true}]);
        if (releaseCountries===undefined) releaseCountries=replyCountries;
        else replyCountries();
        return;
      }
      if (view==='services') {page([{id:'DIGITAL_PIN',name:'Digital PIN'}]);return;}
      if (view==='providers') {page([{id:'provider-fixture',name:'Fixture provider'}]);return;}
      if (view==='products') {
        if (url.searchParams.get('search')==='none') {page([]);return;}
        if (url.searchParams.get('cursor')===cursor) {page([{id:'2',name:'Second product'}]);return;}
        page([{id:'1',name:'First product'}],cursor);return;
      }
      if (view==='offers') {page([{id:'offer',providerId:'Fixture provider',available:true,validUntil:'2026-11-20T18:00:00Z',
        freshness:'CURRENT',sourceObservedAt:'2026-11-20T17:00:00Z',sourceCompletedAt:'2026-11-20T17:01:00Z',
        ...(privatePrice==='permitted'&&{providerCost:'96.00'})}]);return;}
      if (view==='economics') {
        if (privatePrice==='denied') {reply(403,{state:'FORBIDDEN'});return;}
        page([{id:'economics',name:'First product',total:'102.00',providerCost:'96.00',margin:'4.00'}]);return;
      }
      if (view==='publications') {page([{id:'publication',revision:'3',action:'ROLLBACK',occurredAt:'2026-11-20T17:00:00Z'}]);return;}
      page([{id:'draft',version:1,status:'DRAFT'}]);return;
    }
    if (url.pathname==='/staff-api/commands/publication' || url.pathname==='/staff-api/commands/publication/confirm') {
      if(req.method==='GET'){
        reply(200,publicationAction ? {state:'READY',action:publicationAction,productId:actor,candidateId:'a'.repeat(64),candidateVersion:3,
          expectedActiveId:publicationAction==='APPROVE'?null:tenant,rollbackSourceId:publicationAction==='ROLLBACK'?requestId:null,
          reason:publicationAction==='ROLLBACK'?'Restore fixture price':null,idempotencyKey:requestId} : {state:'STEP_UP_REQUIRED'});
        return;
      }
      let body='';
      req.on('data',chunk=>{body+=chunk;});
      req.on('end',()=>{
        received.push({path:url.pathname,csrf:req.headers['x-csrf-token'],body:JSON.parse(body)});
        reply(200,{state:'RECORDED'});
      });
      return;
    }
    if (url.pathname.startsWith('/staff-api/commands/suspension')) {
      if (req.method==='GET') {reply(200,command==='READY'?{state:'READY',targetStaffId:actor,requestId,requestVersion:'1',...(reviewDecision&&{decision:reviewDecision})}:{state:command});return;}
      let body='';
      req.on('data',chunk=>{body+=chunk;});
      req.on('end',()=>{
        received.push({path:url.pathname,csrf:req.headers['x-csrf-token'],body:JSON.parse(body)});
        if (url.pathname.endsWith('/confirm')) reply(200,{state:reviewDecision?'RECORDED':'APPLIED'});
        else reply(403,{state:'FORBIDDEN'});
      });
      return;
    }
    const asset=browserAsset(assets,req.url);
    if(asset){res.writeHead(200,{'content-type':asset.type});res.end(asset.body);return;}
    reply(404,{});
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const initialPage=origin+'/catalogue?fixture=0';
  const browserVariables=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LOCALAPPDATA','APPDATA',
    'USERPROFILE','HOME','HOMEDRIVE','HOMEPATH','PROGRAMFILES','PROGRAMFILES(X86)','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']);
  const browserEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>browserVariables.has(name.toUpperCase())));
  let browser,ws,targetAtFixture=false;
  let diagnostics="";
  try {
    browser=spawn(executable,['--headless=new','--disable-gpu','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
      '--disable-background-networking','--disable-sync','--disable-extensions','--disable-component-update','--no-first-run',
      '--no-default-browser-check','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--enable-logging=stderr','--log-level=2','--window-size=1280,900','--user-data-dir='+profile,'about:blank'],
    {env:browserEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
    browser.on('error',error=>{diagnostics+=error.code;});
    let announcedPort;
    function capture(chunk) {
      diagnostics=(diagnostics+chunk.toString()).slice(-16000);
      const address=diagnostics.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d{4,5})\/devtools\/browser\/[a-f0-9-]+/i);
      if(address) announcedPort=address[1];
    }
    browser.stderr.on('data',capture);
    browser.stdout.on('data',capture);
    const targets=await until(async()=>{
      if (browser.exitCode!==null) throw new Error('Headless browser exited');
      const port=announcedPort ?? (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];
      if(!/^\d{4,5}$/.test(port)||Number(port)<1024||Number(port)>65535)return false;
      const debuggerOrigin='127.0.0.1:'+port;
      const response=await fetch('http://'+debuggerOrigin+'/json/list',{signal:AbortSignal.timeout(1500)});
      const pages=await response.json();
      const target=pages.find(candidate=>candidate.type==='page'&&candidate.url==='about:blank'&&typeof candidate.webSocketDebuggerUrl==='string');
      if(!target)return false;
      const address=new URL(target.webSocketDebuggerUrl);
      return address.protocol==='ws:'&&address.host===debuggerOrigin&&address.pathname.startsWith('/devtools/page/') ? address.href : false;
    },'Headless browser debugger unavailable',35000);
    ws=new WebSocket(targets);
    await once(ws,'open',{signal:AbortSignal.timeout(5000)});
    let sequence=0;
    const pending=new Map();
    ws.addEventListener('message',event=>{
      const data=JSON.parse(event.data);
      const item=pending.get(data.id);
      if(!item)return;
      pending.delete(data.id);
      clearTimeout(item.timer);
      if(data.error)item.reject(new Error(data.error.message));else item.resolve(data.result);
    });
    function send(method,params={}) {
      return new Promise((resolve,reject)=>{
        const id=++sequence;
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout for '+method));},18000);
        pending.set(id,{resolve,reject,timer});
        ws.send(JSON.stringify({id,method,params}));
      });
    }
    async function run(expression) {
      const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    const visible=(text)=>until(()=>run(`document.body.textContent.includes(${JSON.stringify(text)})`),text+' missing');
    const click=(text)=>run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
    const fill=(id,value)=>run(`(()=>{const input=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const select=(label,value)=>run(`(()=>{const input=[...document.querySelectorAll('label')].find(l=>l.firstChild.textContent===${JSON.stringify(label)}).querySelector('select');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    let navigation=0;
    async function go(route){
      const url=origin+route+'?fixture='+ ++navigation;
      const result=await send('Page.navigate',{url});
      assert.equal(result.errorText,undefined);
      await until(()=>run(`location.href===${JSON.stringify(url)} && document.readyState==='complete'`),'Browser navigation incomplete');
    }

    const initialNavigation = await send('Page.navigate',{url:initialPage});
    assert.equal(initialNavigation.errorText,undefined);
    await until(()=>run(`location.href===${JSON.stringify(initialPage)} && document.readyState==='complete'`),
      'Initial React page did not render',30000);
    targetAtFixture=true;
    await visible('Loading…');
    await until(()=>releaseCountries,'Catalogue loading request did not start');
    releaseCountries();
    await visible('United Arab Emirates');await select('Region','EUROPE');
    await visible('Germany');
    assert.equal(await run("document.querySelector('option[value=DE]').disabled"),true);
    assert.deepEqual([...groupQueries],['GCC','EUROPE']);
    await select('Region','GCC');await visible('United Arab Emirates');await select('Country','AE');
    await visible('Digital PIN');await select('Service','DIGITAL_PIN');
    await visible('Fixture provider');await select('Provider','provider-fixture');
    await visible('First product');await click('Load more');
    await visible('Second product');await select('Product','1');
    await visible('Total 102.00 AED');await visible('Provider cost 96.00 AED');await visible('Margin 4.00 AED');
    await visible('Observed 2026-11-20T17:00:00Z');await visible('Snapshot completed 2026-11-20T17:01:00Z');
    await visible('Valid until');await visible('Revision 3');
    await run("document.querySelector('input[type=checkbox]').click()");
    await until(()=>run(`performance.getEntriesByType('resource').some(e=>{
      const url=new URL(e.name);return url.pathname==='/staff-api/catalogue/offers'&& !url.searchParams.has('provider');
    })`),'All-provider comparison did not fetch the product scope');
    await fill('catalogue-product-search','none');await click('Search');
    await visible('No products match this selection.');

    privatePrice='denied';
    await go('/catalogue');
    await visible('United Arab Emirates');await select('Country','AE');
    await visible('Digital PIN');await select('Service','DIGITAL_PIN');
    await visible('Fixture provider');await select('Provider','provider-fixture');
    await visible('First product');await select('Product','1');
    await visible('Your current access does not permit this view.');
    assert.equal(await run("document.body.textContent.includes('Margin 4.00 AED')"),false);
    assert.equal(await run("document.body.textContent.includes('Provider cost 96.00 AED')"),false);

    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await send('Page.bringToFront');
    const openNav="document.querySelector('button[aria-label=\"Open navigation\"]')";
    await until(()=>run(openNav+".getBoundingClientRect().width>0"),'Mobile navigation is not visible');
    await run(openNav+'.focus()');
    assert.equal(await run('document.activeElement==='+openNav),true);
    const enter={key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13};
    await send('Input.dispatchKeyEvent',{...enter,type:'keyDown',text:'\r',unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent',{...enter,type:'keyUp'});
    await until(()=>run(openNav+".getAttribute('aria-expanded')==='true'"),'Keyboard did not open mobile navigation');
    await run("document.querySelector('a[href=\"/staff/commands\"]').click()");
    await until(()=>run("location.pathname==='/staff/commands'"),'Staff command navigation did not complete');
    await visible('Verify identity');
    await fill('suspension-request-id',requestId);await click('Verify identity');
    await visible('your current access does not permit it');
    assert.equal(received.at(-1).csrf,key);
    assert.deepEqual(Object.keys(received.at(-1).body).sort(),['idempotencyKey','requestId']);
    assert.equal(received.at(-1).body.requestId,requestId);
    command='READY';
    await go('/staff/commands');
    await visible('Confirm suspension');await click('Confirm suspension');
    await visible('The membership was suspended and existing sessions were revoked.');
    assert.deepEqual(received.at(-1).body,{});

    for(const [decision,label] of [['APPROVE','Confirm approval'],['REJECT','Confirm rejection']]) {
      reviewDecision=decision;
      await go('/staff/commands');
      await visible(label);await click(label);
      await visible('Your review decision was recorded.');
      assert.deepEqual(received.at(-1).body,{});
    }

    await go('/catalogue/publication');
    await visible('Disposable publication');
    await visible('Verify your identity before confirming');
    for(const [action,label] of [['APPROVE','Confirm approval'],['ACTIVATE','Confirm activation'],['ROLLBACK','Confirm rollback']]) {
      publicationAction=action;
      await go('/catalogue/publication');
      await visible(action==='ROLLBACK'?'Restore fixture price':label);
      await click(label);
      await visible('The publication command was recorded in the disposable catalogue.');
      assert.equal(received.at(-1).path,'/staff-api/commands/publication/confirm');
      assert.equal(received.at(-1).csrf,key);
      assert.deepEqual(received.at(-1).body,{});
    }

    await go('/overview');
    await visible('Your staff session');
    await run("document.querySelector('.workspace-module[href=\"/staff\"]').click()");
    await visible('Support agent');
    await run("document.querySelector('.workspace-record-link').click()");
    await visible('Membership version');
    await visible('Back to directory');
    await run("document.querySelector('nav a[href=\"/audit\"]').click()");
    await visible('Authorization decision');
    staffEnabled=false;
    await go('/staff');
    await visible('This page is unavailable for your current staff session.');
    assert.equal(await run("document.querySelector('nav a[href=\"/staff\"]')===null"),true);
    expired=true;
    await go('/staff/commands');
    await visible('Staff sign-in is currently unavailable.');
    assert.equal(await run("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Continue with secure sign in'))"),false);
    loginEnabled=true;
    await send('Page.navigate',{url:origin+'/login?sign-in=failed'});
    await visible('The sign-in attempt could not be completed.');
    await until(()=>run("[...document.querySelectorAll('button')].some(b=>!b.disabled&&b.textContent.includes('Continue with secure sign in'))"),'Sign-in button unavailable');
    assert.equal(await run("document.querySelector('input[type=email]')===null"),true);
    await click('Continue with secure sign in');
    await visible('fixture login handoff');
  } catch(error) {
    const launchErrors=diagnostics.split(/\r?\n/).filter(line=>/LoadEnclaveImageW|fallback_task_provider|GPU process/.test(line));
    const evidence={announcedDebugger:diagnostics.includes('DevTools listening on'),targetAtFixture,
      appRequest:fixtureRequests.has('/catalogue'),sessionRequest:fixtureRequests.has('/auth/workspace'),
      launchErrors,cause:error.cause?.message??error.message};
    await writeFile(path.join(root,path.basename(profile)+'.log'),JSON.stringify(evidence,null,2)+'\n','utf8');
    throw error;
  } finally {
    ws?.close();
    if(browser?.exitCode===null && browser.signalCode===null){
      const exit=once(browser,'exit',{signal:AbortSignal.timeout(5000)});
      browser.kill();
      await exit.catch(()=>undefined);
    }
    browser?.stdout.destroy();
    browser?.stderr.destroy();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    const resolved=await realpath(profile);
    assert.equal(path.dirname(resolved),profileRoot);
    assert.ok(path.basename(resolved).startsWith('staff-browser-final-'));
    await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
});
