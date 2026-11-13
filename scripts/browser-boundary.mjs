import { builtinModules, createRequire } from 'node:module';
import { readFileSync, readdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(path.join(repository,'packages/application/package.json'))('typescript');
const extensions=new Set(['.ts','.tsx','.js','.jsx','.mts','.cts','.mjs','.cjs']);
const ignored=new Set(['node_modules','dist','dist-test','build','coverage','__pycache__','.git']);
const approvedPackages=new Set(['react','react-dom','react-router-dom','lucide-react']);
const nodeModules=new Set(builtinModules.flatMap(name=>[name,name.replace(/^node:/,''),'node:'+name.replace(/^node:/,'')]));
const privileged=/^@(?:nukhbapay|nukhabapay)\/(?:application|database|domain|provider-adapters|api|admin-web)(?:\/|$)/;
const credentialKey=/^(?:secret|password|passwd|client_?secret|private_?key|api_?key|access_?token|refresh_?token|database_?url|connection_?string)$/i;

function inside(file,directory){const relative=path.relative(directory,file);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function label(root,file){return path.relative(root,file).replaceAll('\\','/');}
function tree(directory,scanRoot=directory){
  if(!existsSync(directory))return [];
  const files=[];
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(['node_modules','__pycache__','.git'].includes(entry.name)||directory===scanRoot&&ignored.has(entry.name))continue;
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink()){files.push(file);continue;}
    if(entry.isDirectory())files.push(...tree(file,scanRoot));else files.push(file);
  }
  return files;
}
function source(file,text){return ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);}

/** This classification is independent of file basenames and is checked again at build time. */
export function classification(root,file){
  const admin=path.join(root,'apps/admin-web');
  if(inside(file,path.join(admin,'src')))return 'server';
  if(inside(file,path.join(admin,'test')))return 'server-test';
  if(file===path.join(admin,'vite.config.ts'))return 'build';
  if(inside(file,admin))return 'browser'; // Unknown/new directories never acquire server trust.
  if(inside(file,path.join(root,'packages'))&&/^(application|database|domain|provider-adapters)(\/|$)/.test(label(path.join(root,'packages'),file)))return 'backend';
  if(inside(file,path.join(root,'apps')))return 'other-app';
  return 'shared';
}

function secretEvidence(text){
  return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)||
    /postgres(?:ql)?:\/\/[^\s/:@]+:[^\s@]+@/i.test(text)||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/.test(text)||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text);
}
function literal(node){return node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))?node.text:undefined;}
function sensitiveExpression(node){
  if(!node)return false;
  if(ts.isStringLiteralLike(node))return node.text.length>0;
  if(node.kind===ts.SyntaxKind.NullKeyword||node.kind===ts.SyntaxKind.FalseKeyword)return false;
  // Secret-named browser values may not be assembled from other expressions either.
  return true;
}

export function inspectBrowserText(file,text){
  const errors=[],imports=[];
  if(secretEvidence(text))errors.push('credential/private-key evidence');
  if(/\b(?:process\s*(?:\.|\[)|import\s*\.\s*meta)/.test(text))errors.push('server/build environment access');
  const ast=source(file,text);
  if(ast.parseDiagnostics.length)errors.push('unparseable module');
  function add(node){const value=literal(node);if(value===undefined)errors.push('non-literal module loading');else imports.push(value);}
  function visit(node){
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){if(node.moduleSpecifier)add(node.moduleSpecifier);}
    if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))add(node.moduleReference.expression);
    if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))add(node.argument.literal);
    if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'){
        if(node.arguments.length!==1)errors.push('unsupported module loading');else add(node.arguments[0]);
      }
      if(ts.isIdentifier(node.expression)&&['eval','Function'].includes(node.expression.text))errors.push('dynamic code execution');
      if(ts.isPropertyAccessExpression(node.expression)&&node.expression.getText(ast).startsWith('import.meta'))errors.push('unreviewed import.meta loader');
    }
    if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&['Function','Worker','SharedWorker'].includes(node.expression.text))errors.push('unreviewed executable entry');
    if(ts.isPropertyAccessExpression(node)&&['globalThis','window','self'].includes(node.expression.getText(ast))&&['process','require','Buffer'].includes(node.name.text))errors.push('Node global capability');
    if(ts.isElementAccessExpression(node)&&['globalThis','window','self'].includes(node.expression.getText(ast))){
      const key=literal(node.argumentExpression);
      if(key===undefined||['process','require','Buffer'].includes(key))errors.push('dynamic/Node global capability');
    }
    if(ts.isPropertyAssignment(node)||ts.isVariableDeclaration(node)){
      const name=ts.isIdentifier(node.name)||ts.isStringLiteralLike(node.name)?node.name.text:'';
      if(credentialKey.test(name)&&sensitiveExpression(node.initializer))errors.push('secret-named browser value');
    }
    if(ts.isIdentifier(node)&&['require','process','Buffer','Deno','Bun','eval','Function'].includes(node.text)){
      if(!(node.text==='require'&&ts.isCallExpression(node.parent)&&node.parent.expression===node))errors.push('Node runtime capability');
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  for(const ref of ast.typeReferenceDirectives)if(ref.fileName!=='vite/client')errors.push('unapproved ambient type dependency');
  for(const ref of ast.referencedFiles)imports.push(ref.fileName.startsWith('.')?ref.fileName:'./'+ref.fileName);
  return {errors:[...new Set(errors)],imports:[...new Set(imports)]};
}

function configuration(root){
  const admin=path.join(root,'apps/admin-web'),client=path.join(admin,'client');
  const configFile=path.join(client,'tsconfig.json');
  const loaded=ts.readConfigFile(configFile,ts.sys.readFile);
  if(loaded.error)throw new Error('Browser TypeScript configuration unavailable');
  if(loaded.config.extends)throw new Error('Browser configuration extends requires review');
  const parsed=ts.parseJsonConfigFileContent(loaded.config,ts.sys,client);
  if(parsed.errors.length)throw new Error('Browser TypeScript configuration rejected');
  const server=JSON.parse(readFileSync(path.join(admin,'tsconfig.json'),'utf8'));
  if(server.compilerOptions?.rootDir!=='src'||JSON.stringify(server.include)!==JSON.stringify(['src/**/*.ts']))throw new Error('BFF compiler boundary changed');
  const viteFile=path.join(admin,'vite.config.ts'),vite=source(viteFile,readFileSync(viteFile,'utf8'));
  const exports=vite.statements.filter(ts.isExportAssignment),allowedImports=new Set(['vite','@vitejs/plugin-react','node:url','../../scripts/browser-boundary.mjs']);
  if(vite.parseDiagnostics.length||exports.length!==1||vite.statements.some(statement=>!ts.isImportDeclaration(statement)&&!ts.isExportAssignment(statement))||
    vite.statements.filter(ts.isImportDeclaration).some(statement=>!allowedImports.has(statement.moduleSpecifier.text)))throw new Error('Vite configuration shape requires review');
  const expression=exports[0].expression;
  if(!ts.isCallExpression(expression)||expression.expression.getText(vite)!=='defineConfig'||expression.arguments.length!==1||!ts.isObjectLiteralExpression(expression.arguments[0]))throw new Error('Vite configuration must be explicit');
  const properties=expression.arguments[0].properties;
  if(properties.length!==3||properties.some(property=>!ts.isPropertyAssignment(property)))throw new Error('Vite entry/alias/environment configuration requires review');
  const values=Object.fromEntries(properties.map(property=>[property.name.getText(vite),property.initializer]));
  if(Object.keys(values).sort().join(',')!=='build,plugins,root'||
    values.root.getText(vite).replace(/\s/g,'')!=="fileURLToPath(newURL('./client',import.meta.url))"||
    values.plugins.getText(vite).replace(/\s/g,'')!=='[browserBoundaryPlugin(),react()]'||!ts.isObjectLiteralExpression(values.build))throw new Error('Vite browser root or build guard changed');
  const build=values.build.properties;
  if(build.length!==4||build.some(property=>!ts.isPropertyAssignment(property)))throw new Error('Vite build configuration requires review');
  const outputs=Object.fromEntries(build.map(property=>[property.name.getText(vite),property.initializer.getText(vite)]));
  if(outputs.outDir!=="'../dist/client'"||outputs.emptyOutDir!=='true'||outputs.sourcemap!=='false'||outputs.manifest!=='true')throw new Error('Vite output configuration requires review');
  return parsed.options;
}

/** Source graph: all current/future browser files plus every resolved shared dependency. */
export function auditBrowserBoundary(root=repository){
  root=path.resolve(root);
  const admin=path.join(root,'apps/admin-web'),client=path.join(admin,'client'),errors=[],visited=new Set();
  let options;
  try{options=configuration(root);}catch{return {errors:['Browser build configuration rejected'],files:[]};}
  function reject(file,reason){errors.push(`${label(root,file)}: ${reason}`);}
  function walk(file){
    file=path.resolve(file);
    if(!inside(file,root)){reject(file,'dependency outside repository');return;}
    if(!existsSync(file)){reject(file,'unresolved local dependency');return;}
    const canonical=realpathSync(file);
    if(canonical!==file){reject(file,'symlinked dependency requires review');return;}
    if(visited.has(file))return;
    visited.add(file);
    const kind=classification(root,file);
    if(!['browser','shared'].includes(kind)){reject(file,'browser reaches '+kind+' module');return;}
    if(/(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|pfx|p12|clixml)$/i.test(label(root,file))){reject(file,'private configuration asset');return;}
    const text=readFileSync(file,'utf8');
    if(secretEvidence(text)){reject(file,'credential/private-key evidence');return;}
    if(file.endsWith('.json')){
      try{const inspect=value=>{if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){if(credentialKey.test(k)&&v)reject(file,'secret configuration value');inspect(v);}};inspect(JSON.parse(text));}
      catch{reject(file,'unparseable JSON dependency');}return;
    }
    if(file.endsWith('.css')){
      if(/@import|url\s*\(/i.test(text))reject(file,'CSS dependency loading requires review');
      return;
    }
    if(!extensions.has(path.extname(file))){
      if(!['.png','.jpg','.jpeg','.webp','.ico'].includes(path.extname(file)))reject(file,'unreviewed dependency file type');
      return;
    }
    const inspected=inspectBrowserText(file,text);
    inspected.errors.forEach(reason=>reject(file,reason));
    for(const specifier of inspected.imports){
      if(privileged.test(specifier)||nodeModules.has(specifier)||specifier.startsWith('node:')){reject(file,'forbidden module import');continue;}
      if(/[?!#]/.test(specifier)||/^(?:https?:|data:|file:|\/)/.test(specifier)){reject(file,'unreviewed module source');continue;}
      const resolved=ts.resolveModuleName(specifier,file,options,ts.sys).resolvedModule;
      if(resolved&&!resolved.isExternalLibraryImport){walk(resolved.resolvedFileName);continue;}
      if(specifier.startsWith('.')){
        const exact=path.resolve(path.dirname(file),specifier);
        if(existsSync(exact)&&!lstatSync(exact).isDirectory())walk(exact);else reject(file,'unresolved relative import');
        continue;
      }
      const packageName=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
      if(!approvedPackages.has(packageName))reject(file,'unapproved package or unresolved alias');
    }
  }
  for(const file of tree(admin)){
    if(classification(root,file)==='browser'){
      if(lstatSync(file).isSymbolicLink())reject(file,'symlinked browser source requires review');
      else if(extensions.has(path.extname(file)))walk(file);
    }
  }
  // HTML entry points cannot declare an independent script source or inline executable.
  for(const file of tree(client).filter(p=>p.endsWith('.html'))){
    const html=readFileSync(file,'utf8');
    if(secretEvidence(html)||/\bon\w+\s*=|javascript:/i.test(html))reject(file,'unsafe HTML executable/credential');
    const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    for(const match of scripts){
      const src=/\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
      if(match[2].trim()||!src||!/\btype\s*=\s*["']module["']/i.test(match[1])||!src.startsWith('/src/')||src.includes('..')||/[?#%\\]/.test(src))reject(file,'unreviewed HTML script entry');
      else walk(path.join(client,src.slice(1)));
    }
    if(file===path.join(client,'index.html')&&scripts.length!==1)reject(file,'missing or ambiguous browser entry');
  }
  for(const file of tree(path.join(client,'public'))){
    if(lstatSync(file).isSymbolicLink()){reject(file,'symlinked public asset');continue;}
    if(!['.png','.jpg','.jpeg','.webp','.ico'].includes(path.extname(file))||secretEvidence(readFileSync(file,'utf8')))reject(file,'unreviewed public asset');
  }
  return {errors:[...new Set(errors)].sort(),files:[...visited].map(file=>label(root,file)).sort()};
}

function prohibitedBuiltModule(root,id){
  if(id.includes('__vite-browser-external')||/node_modules[\\/]@(?:nukhbapay|nukhabapay)[\\/](?:application|database|domain|provider-adapters)(?:[\\/]|$)/.test(id))return true;
  if(id.startsWith('\0'))return false;
  if(nodeModules.has(id)||id.startsWith('node:')||privileged.test(id))return true;
  const file=id.split('?')[0];
  if(path.isAbsolute(file)&&!file.includes('/node_modules/')&&!file.includes('\\node_modules\\'))return !['browser','shared'].includes(classification(root,path.resolve(file)));
  return false;
}

/** Vite/Rollup's actual module graph is a second gate, independent of TS resolution. */
export function browserBoundaryPlugin(root=repository){
  return {name:'nukhbapay-browser-boundary',enforce:'pre',
    buildStart(){const result=auditBrowserBoundary(root);if(result.errors.length)this.error(result.errors.join('\n'));},
    generateBundle(_options,bundle){
      const modules=[];
      for(const id of this.getModuleIds()){
        const info=this.getModuleInfo(id);
        if(prohibitedBuiltModule(root,id)||info?.isExternal)this.error('Forbidden module in browser build: '+label(root,id));
        modules.push(path.isAbsolute(id)?label(root,id):id);
      }
      for(const asset of Object.values(bundle)){
        const text=asset.type==='chunk'?asset.code:typeof asset.source==='string'?asset.source:Buffer.from(asset.source).toString('utf8');
        if(secretEvidence(text))this.error('Credential/private-key evidence in browser output');
      }
      // Runtime asset serving is explicit: this JSON report is never in its asset map.
      this.emitFile({type:'asset',fileName:'browser-boundary-report.json',source:JSON.stringify({profile:'BROWSER_BOUNDARY_V1',modules:modules.sort()},null,2)});
    }};
}

export function verifyBrowserBuild(root=repository){
  const directory=path.join(root,'apps/admin-web/dist/client');
  const report=path.join(directory,'browser-boundary-report.json');
  const errors=[];
  if(!existsSync(report))return ['Missing browser build boundary evidence'];
  let evidence;try{evidence=JSON.parse(readFileSync(report,'utf8'));}catch{return ['Invalid browser build boundary evidence'];}
  if(evidence.profile!=='BROWSER_BOUNDARY_V1'||!Array.isArray(evidence.modules)||!evidence.modules.length)return ['Invalid browser build boundary evidence'];
  for(const id of evidence.modules)if(prohibitedBuiltModule(root,id.startsWith('\0')?id:path.resolve(root,id)))errors.push('Forbidden module in browser build evidence');
  for(const file of tree(directory)){
    if(extensions.has(path.extname(file))||['.html','.css','.json'].includes(path.extname(file)))if(secretEvidence(readFileSync(file,'utf8')))errors.push('Credential/private-key evidence in browser output: '+label(root,file));
  }
  return errors;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=auditBrowserBoundary();
  const errors=[...result.errors,...(process.argv.includes('--verify-build')?verifyBrowserBuild():[])];
  if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
  else console.info(`Browser/BFF source boundary passed (${result.files.length} inspected modules)${process.argv.includes('--verify-build')?'; production module graph and output passed':''}.`);
}
