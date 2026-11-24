import {spawnSync} from 'node:child_process';
import {mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Source builds and isolated tests only. No migration/integration runner,
// PostgreSQL configuration, provider activation, installation or deployment.
if(process.argv.length!==2)throw new Error('Offline development tests accept no arguments');
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=path.join(root,'.local',`master-development-offline-${Date.now()}`);
mkdirSync(directory,{recursive:true});
console.info(`Evidence: ${path.relative(root,directory)}/results.json`);
const env={};
const allowed=['PATH','PATHEXT','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS',
  'LOCALAPPDATA','APPDATA','USERPROFILE','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA'];
for(const [key,value] of Object.entries(process.env))if(allowed.includes(key.toUpperCase()))env[key]=value;
Object.assign(env,{CI:'true',COREPACK_ENABLE_NETWORK:'0',PYTHONDONTWRITEBYTECODE:'1',NUKHBAPAY_STAFF_SESSION_MODE:'disabled'});
const pythonProbe=spawnSync('python',['-c','import sys; print(sys.executable)'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:30000});
const python=(pythonProbe.status===0?pythonProbe.stdout.trim():undefined);
if(python)env.NUKHBAPAY_AI_TEST_PYTHON=python;
const results=[];
function run(name,executable,args){
  console.info(`RUN ${name}`);
  const started=Date.now(),result=spawnSync(executable,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:32*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  writeFileSync(path.join(directory,name+'.log'),output);
  const count=Number(output.match(/(?:^|\n)[#\u2139] tests (\d+)/)?.[1]??output.match(/Ran (\d+) tests? in /)?.[1]??0);
  const failed=Number(output.match(/(?:^|\n)[#\u2139] fail (\d+)/)?.[1]??0);
  const skipped=Number(output.match(/(?:^|\n)[#\u2139] skipped (\d+)/)?.[1]??0);
  const passed=result.status===0&&!result.error;
  results.push({name,passed,tests:count,failed,skipped,exitCode:result.status,elapsedMs:Date.now()-started});
  writeFileSync(path.join(directory,'results.json'),JSON.stringify({scope:'OFFLINE_SYNTHETIC_ONLY',postgresql:'NOT_RUN',realProviders:'NOT_RUN',results},null,2));
  console.info(`${passed?'PASS':'FAIL'} ${name}${count?` (${count} tests, ${skipped} skipped)`:''}`);
  if(!passed){console.error(output.slice(-8000));process.exitCode=1;}
  return passed;
}
const node=(name,args)=>run(name,process.execPath,args);
const compile=(folder,config,name)=>node(name,[`${folder}/node_modules/typescript/bin/tsc`,'-p',`${folder}/${config}`]);
for(const [folder,name] of [['packages/application','application'],['packages/database','database'],['apps/worker','worker'],['apps/api','api'],['apps/admin-web','staff']]){
  if(!compile(folder,'tsconfig.json',name+'-build'))process.exit(1);
  if(!compile(folder,'tsconfig.test.json',name+'-test-build'))process.exit(1);
}
if(!node('react-typecheck',['apps/admin-web/node_modules/typescript/bin/tsc','--noEmit','-p','apps/admin-web/client/tsconfig.json']))process.exit(1);
if(!node('react-build',['apps/admin-web/node_modules/vite/bin/vite.js','build','--configLoader','native','--config','apps/admin-web/vite.config.ts']))process.exit(1);
const suite=(name,folder,suffix)=>node(name,['--test',...readdirSync(path.join(root,folder)).filter(n=>n.endsWith(suffix)).sort().map(n=>folder+'/'+n)]);
suite('application','packages/application/dist-test/application/test','.test.js');
const databaseTests=['config','identity-runtime-config','staff-session-runtime-config','identity-transactions','ai-job-store','publication-connection-cleanup','catalogue-refresh-store','staff-catalogue-reader'];
node('database-offline',['--test',...databaseTests.map(n=>`packages/database/dist-test/database/test/${n}.spec.js`)]);
// Validate the Python source/import boundary before admitting timed fixture jobs.
// This is a separate startup check, not cold-start performance acceptance; the
// engine's four-second deadline and every R6 control budget remain unchanged.
if(run('python-worker-preflight',python??'python',['-S','-c',
  "import sys; sys.path.insert(0, 'apps/ai-service/src'); import nukhbapay_ai.jobs.stdio_worker"])) {
  suite('worker','apps/worker/dist-test/test','.test.js');
}
suite('api','apps/api/dist-test/test','.spec.js');
node('staff-https',['scripts/test/run-staff-synthetic-tests.mjs','--built']);
node('domain-providers',['--experimental-strip-types','--test',
  ...['packages/domain/test','packages/provider-adapters/test'].flatMap(folder=>readdirSync(path.join(root,folder)).filter(n=>n.endsWith('.test.ts')).map(n=>folder+'/'+n))]);
node('auth0-tools',['--test',...readdirSync(path.join(root,'scripts/test')).filter(n=>/^auth0.*\.test\.mjs$/.test(n)).sort().map(n=>'scripts/test/'+n)]);
node('browser-boundary',['--test','scripts/test/browser-boundary.test.mjs']);
node('frozen-migrations',['scripts/rehearse-reviewed-migrations.mjs','--verify-only']);
node('local-catalogue-startup',['--test','scripts/test/local-catalogue-startup.test.mjs']);
node('activation-source-only',['--test','scripts/test/persistent-development-iam.test.mjs','scripts/test/persistent-activation-preparation.test.mjs']);
run('python-ai',python??'python',['-m','unittest','discover','-s','apps/ai-service/tests','-v']);
run('structure',python??'python',['scripts/check_structure.py']);
console.info(`Evidence: ${path.relative(root,directory)}/results.json`);
console.info('PostgreSQL acceptance and real-provider acceptance: NOT RUN.');
