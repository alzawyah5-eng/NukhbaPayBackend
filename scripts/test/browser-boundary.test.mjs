import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditBrowserBoundary, browserBoundaryPlugin, verifyBrowserBuild } from '../browser-boundary.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
function fixture(work){
  const root=mkdtempSync(path.join(tmpdir(),'nukh-boundary-test-'));
  const put=(name,text)=>{const file=path.join(root,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,text);};
  const config={compilerOptions:{module:'ESNext',moduleResolution:'Bundler',baseUrl:'.'},include:['src']};
  put('apps/admin-web/vite.config.ts',readFileSync(path.join(repository,'apps/admin-web/vite.config.ts'),'utf8'));
  put('apps/admin-web/tsconfig.json',JSON.stringify({compilerOptions:{rootDir:'src'},include:['src/**/*.ts']}));
  put('apps/admin-web/client/tsconfig.json',JSON.stringify(config));
  put('apps/admin-web/client/index.html','<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>');
  put('apps/admin-web/client/src/main.tsx','export const page = 1;');
  try{return work({root,put,config,check:()=>auditBrowserBoundary(root),saveConfig:()=>put('apps/admin-web/client/tsconfig.json',JSON.stringify(config))});}
  finally {assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.match(path.basename(root),/^nukh-boundary-test-[A-Za-z0-9]+$/);rmSync(root,{recursive:true,force:true});}
}
const denied=(result)=>assert.ok(result.errors.length>0,'A prohibited dependency must never pass the boundary');

test('approved Node BFF source and server tests accept application, database and Node security imports',()=>fixture(f=>{
  f.put('apps/admin-web/src/another-service.ts',"import { x } from '@nukhbapay/application'; import { y } from '@nukhbapay/database'; import { randomBytes } from 'node:crypto';");
  f.put('apps/admin-web/test/another.spec.ts',"import { x } from '@nukhbapay/application'; import assert from 'node:assert';");
  assert.deepEqual(f.check().errors,[]);
}));

test('browser components, utilities and pure shared graphs accept safe imports, cycles and approved browser packages',()=>fixture(f=>{
  f.put('apps/admin-web/client/src/component.tsx',"import { x } from './lib/util'; export const component=x;");
  f.put('apps/admin-web/client/src/lib/util.ts','export const x=1;');
  f.put('apps/admin-web/client/src/main.tsx',"import React from 'react'; import './component'; import '../../../../shared/a';");
  f.put('shared/a.ts',"import './b'; export const a=1;");
  f.put('shared/b.ts',"import './a'; export const b=1;");
  assert.deepEqual(f.check().errors,[]);
}));

for(const location of ['client/src/main.tsx','client/src/components/New.tsx','client/src/lib/new.ts',
  'shared/new.ts','unexpected/deep/new.mjs','client/dist/new.ts','client/src/test/new.ts']) {
  test('rejects backend package import from '+location,()=>fixture(f=>{
    f.put('apps/admin-web/'+location,"import { StaffSessionLifecycle } from '@nukhbapay/application';");denied(f.check());
  }));
}
for(const specifier of ['@nukhbapay/application/verified-identity','@nukhbapay/database','@nukhbapay/domain',
  '@nukhbapay/provider-adapters','@nukhabapay/application','@nukhbapay/admin-web/auth0','node:crypto','node:fs','crypto','fs','jose','pg']) {
  test('rejects privileged/Node/security package '+specifier,()=>fixture(f=>{
    f.put('apps/admin-web/client/src/main.tsx',`import * as authority from '${specifier}';`);denied(f.check());
  }));
}
for(const mode of ['static','reexport','type','require','dynamic','import-equals']){
  test('rejects '+mode+' dependency through a pure-looking shared module',()=>fixture(f=>{
    f.put('apps/admin-web/client/src/main.tsx',"import '../../../../shared/first';");
    f.put('shared/first.ts',"export * from './second';");
    const forms={static:"import x from '@nukhbapay/database';",reexport:"export * from '@nukhbapay/database';",type:"type X=import('@nukhbapay/database').X;",
      require:"const x=require('@nukhbapay/database');",dynamic:"void import('@nukhbapay/database');",'import-equals':"import x = require('@nukhbapay/database');"};
    f.put('shared/second.ts',forms[mode]);denied(f.check());
  }));
}
for(const relative of ['../../src/auth0.js','../../test/helper.js','../../vite.config.ts','../../../../packages/database/src/index.js']){
  test('rejects relative privileged boundary '+relative,()=>fixture(f=>{
    f.put('apps/admin-web/src/auth0.ts','export const x=1;');
    f.put('apps/admin-web/test/helper.ts','export const x=1;');
    f.put('packages/database/src/index.ts','export const x=1;');
    f.put('apps/admin-web/client/src/main.tsx',`import '${relative}';`);denied(f.check());
  }));
}
test('TypeScript package alias cannot disguise a backend path',()=>fixture(f=>{
  f.config.compilerOptions.paths={'@shared/*':['../../../shared/*']};f.saveConfig();
  f.put('apps/admin-web/client/src/main.tsx',"import '@shared/bridge';");
  f.put('shared/bridge.ts',"export * from '../packages/database/src/index';");
  f.put('packages/database/src/index.ts','export const x=1;');denied(f.check());
}));
test('an alias that looks like an approved React import cannot reach server source',()=>fixture(f=>{
  f.config.compilerOptions.paths={react:['../src/authority']};f.saveConfig();
  f.put('apps/admin-web/src/authority.ts','export const x=1;');
  f.put('apps/admin-web/client/src/main.tsx',"import x from 'react';");denied(f.check());
}));

for(const code of ["const name='backend'; void import(name);","const loader=require; loader('backend');",
  "const x=globalThis['process']['env'];","const key='process'; const x=globalThis[key];",
  "const x=import.meta.env.CLIENT_SECRET;","const x=process.env.CLIENT_SECRET;", "eval('server code');",
  "new Worker('./hidden.js');","const x = ;", "/// <reference types=\"node\" />\nexport {};",
  "const clientSecret='synthetic-secret-that-must-not-ship';", "const x={password:'synthetic-private-password'};",
  "const x={apiKey: ['assembled','secret'].join('-')};",
  "const secret='synthetic-private';", "const x=Buffer.from('private');",
  "const x='-----BEGIN PRIVATE KEY-----';","const x='postgresql://synthetic:synthetic@127.0.0.1/db';"]) {
  test('rejects opaque loader, environment or private browser material '+String(code.indexOf('='))+' '+code.slice(0,22),()=>fixture(f=>{
    f.put('apps/admin-web/client/src/main.tsx',code);denied(f.check());
  }));
}
test('JSON and raw/query imports cannot expose private configuration',()=>fixture(f=>{
  f.put('apps/admin-web/client/src/main.tsx',"import config from './config.json';");
  f.put('apps/admin-web/client/src/config.json',JSON.stringify({clientSecret:'synthetic-private'}));denied(f.check());
  f.put('apps/admin-web/client/src/main.tsx',"import secret from '../../src/auth0.ts?raw';");denied(f.check());
}));
test('CSS imports and unsupported executable asset types cannot hide dependencies',()=>fixture(f=>{
  f.put('apps/admin-web/client/src/main.tsx',"import './unsafe.css';");
  f.put('apps/admin-web/client/src/unsafe.css',"@import '../../src/auth0.ts';");denied(f.check());
  f.put('apps/admin-web/client/src/main.tsx',"import './secret.py';");
  f.put('apps/admin-web/client/src/secret.py','secret = "synthetic"');denied(f.check());
}));
test('unreviewed public script, HTML inline script and external entry cannot bypass graph checking',()=>fixture(f=>{
  f.put('apps/admin-web/client/public/hidden.js','export const safe=1;');denied(f.check());
  f.put('apps/admin-web/client/index.html','<script>import("node:crypto")</script>');denied(f.check());
  f.put('apps/admin-web/client/index.html','<script src="https://attacker.invalid/hidden.js"></script>');denied(f.check());
}));
test('Vite aliases, root changes and disabled build guard require review rather than an exemption',()=>fixture(f=>{
  const file=path.join(f.root,'apps/admin-web/vite.config.ts'),original=readFileSync(file,'utf8');
  for(const value of [original.replace("new URL('./client'","new URL('./src'"),original.replace('browserBoundaryPlugin(), ',''),
    original.replace('plugins:',"resolve: { alias: { '@hidden': './src' } }, plugins:")]){
    f.put('apps/admin-web/vite.config.ts',value);denied(f.check());
  }
}));

test('actual build graph independently rejects privileged and Node modules, even when the source fixture is safe',()=>fixture(f=>{
  for(const id of [path.join(f.root,'apps/admin-web/src/auth0.ts'),path.join(f.root,'packages/application/src/index.ts'),
    path.join(f.root,'node_modules/@nukhbapay/database/index.js'),'node:crypto','\0__vite-browser-external:node:crypto']){
    const plugin=browserBoundaryPlugin(f.root);
    assert.throws(()=>plugin.generateBundle.call({getModuleIds:()=>[id],getModuleInfo:()=>({isExternal:false}),error:()=>{throw new Error('DENIED');},emitFile:()=>{}},{},{}),/DENIED/);
  }
}));
test('build evidence is mandatory, validates the module graph and scans every emitted text asset',()=>fixture(f=>{
  assert.ok(verifyBrowserBuild(f.root).length);
  f.put('apps/admin-web/dist/client/browser-boundary-report.json',JSON.stringify({profile:'BROWSER_BOUNDARY_V1',modules:['apps/admin-web/src/auth0.ts']}));
  denied({errors:verifyBrowserBuild(f.root)});
  f.put('apps/admin-web/dist/client/browser-boundary-report.json',JSON.stringify({profile:'BROWSER_BOUNDARY_V1',modules:['apps/admin-web/client/src/main.tsx']}));
  assert.deepEqual(verifyBrowserBuild(f.root),[]);
  f.put('apps/admin-web/dist/client/assets/private.js','const key="-----BEGIN PRIVATE KEY-----";');
  denied({errors:verifyBrowserBuild(f.root)});
}));
