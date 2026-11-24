import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Source-only preparation. No SQL/client/provider imports, executable launch,
// process/listener probing, credential reads or execution/approval switch.
if(process.argv.length!==3||process.argv[2]!=='--prepare')throw new Error('Only --prepare is supported; runtime execution is not authorized');
const root=fileURLToPath(new URL('../',import.meta.url));
const r6Root=path.resolve(root,'../nukhabapay-worktrees/brick4-platform');
const sha=b=>createHash('sha256').update(b).digest('hex');
const readJson=p=>JSON.parse(readFileSync(p,'utf8'));
function pin(base,relative){const target=path.resolve(base,relative),rel=path.relative(base,target);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Manifest path escapes source root');
 const bytes=readFileSync(target);return {path:relative,bytes:bytes.length,sha256:sha(bytes)};}
const governancePath='docs/security/owner-review/current-brick4-review-governance.json';
const governance=readJson(path.join(r6Root,governancePath));
const candidate=pin(r6Root,governance.candidate.path);
if(candidate.sha256!==governance.candidate.sha256||candidate.bytes!==governance.candidate.bytes)throw new Error('R6 governance candidate pin mismatch');
const release=readJson(path.join(r6Root,candidate.path));
function compare(pins){return pins.map(expected=>{try{const actual=pin(r6Root,expected.path);return {path:expected.path,match:actual.sha256===expected.sha256&&actual.bytes===expected.bytes};}catch{return {path:expected.path,match:false};}});}
const sourcePins=compare(release.sourceSqlCompiledExecutableAndTestPins),snapshotPins=compare(release.snapshotPins);
const git=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
if(git.status!==0)throw new Error('Cannot enumerate local source');
const sources=[...new Set(git.stdout.split('\0').filter(p=>/^(apps|packages|scripts|docs)\//.test(p)&&/\.(ts|tsx|py|mjs|sql|json|md|yaml)$/.test(p)))].sort().map(p=>pin(root,p));
const report={schemaVersion:'NUKHBAPAY_RUNTIME_QUALIFICATION_PREPARATION_V1',preparedAt:new Date().toISOString(),scope:'SOURCE_AND_OFFLINE_ONLY',
 releaseDecision:'NO_GO',approvalIssued:false,executionAuthorized:false,postgresql:'NOT_RUN',auth0Mfa:'NOT_RUN',realProviders:'NOT_RUN',deployment:'NOT_AUTHORIZED',
 r6:{worktree:r6Root,governance:pin(r6Root,governancePath),candidate,ownerAcceptance:governance.candidateOwnerAcceptance,executionAuthorization:governance.executionAuthorization,
   sourcePins,snapshotPins,allSourcePinsMatch:sourcePins.every(p=>p.match),allSnapshotPinsMatch:snapshotPins.every(p=>p.match),
   protectedTiming:release.timing,databaseAcceptance:release.databaseAcceptance,mandatoryPending:release.mandatoryPending,
   executableVerification:'PENDING_FRESH_AUTHORIZED_CHECK',physicalProcessListenerVerification:'NOT_RUN',credentialOperations:'NOT_RUN'},
 sources,acceptanceRunbook:'docs/runbooks/runtime-qualification.md',providerGapRegister:'docs/providers/development-gap-register.json',
 migration012:'SEPARATE_UNREGISTERED_UNAPPLIED_PROPOSAL_REQUIRES_REVIEW',
 restrictions:['No acceptance, execution, deployment or zero-risk claim','Historical pins do not establish current physical target or credential identity','R6 authorization never covers new012 SQL or privileged IAM work','No execution command is enabled by this package']};
const directory=path.join(root,'.local','runtime-qualification-'+Date.now());mkdirSync(directory,{recursive:true});
writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.info(JSON.stringify({manifest:path.relative(root,path.join(directory,'manifest.json')),sources:sources.length,r6SourcePins:sourcePins.length,r6SnapshotPins:snapshotPins.length,
 allSourcePinsMatch:report.r6.allSourcePinsMatch,allSnapshotPinsMatch:report.r6.allSnapshotPinsMatch,releaseDecision:'NO_GO',executionAuthorized:false}));
if(!report.r6.allSourcePinsMatch||!report.r6.allSnapshotPinsMatch)process.exitCode=1;
