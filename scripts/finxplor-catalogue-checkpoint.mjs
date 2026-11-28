import {createHash, randomUUID} from 'node:crypto';
import {appendFile, readFile, rename, stat, truncate, writeFile} from 'node:fs/promises';

const cap = 256 * 1024 * 1024;
const ageLimit = 24 * 60 * 60 * 1000;
export async function openFinxplorCheckpoint(root, account) {
  const key = createHash('sha256').update(account.tenantId+':'+account.providerAccountId).digest('hex');
  const file = new URL('finxplor-checkpoint-'+key+'.jsonl',root);
  const archive = () => rename(file,new URL('finxplor-checkpoint-'+key+'-'+randomUUID()+'.jsonl',root));
  let pages = [];
  const confirmations = [];
  const differences = new Map();
  const header = {version:1,tenantId:account.tenantId,providerAccountId:account.providerAccountId,
    observedAt:new Date().toISOString()};
  let size = 0;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size>cap) throw new Error('Invalid catalogue checkpoint');
    size = info.size;
    const content = await readFile(file,'utf8');
    const lastCommit = content.lastIndexOf('\n');
    if (lastCommit<0) throw new Error('Invalid catalogue checkpoint header');
    const records = content.slice(0,lastCommit).split('\n');
    const saved = JSON.parse(records.shift());
    if (saved.version!==1 || saved.tenantId!==header.tenantId || saved.providerAccountId!==header.providerAccountId ||
        !Number.isFinite(Date.parse(saved.observedAt)) || Date.parse(saved.observedAt)>Date.now()) {
      throw new Error('Invalid catalogue checkpoint scope');
    }
    if (Date.now()-Date.parse(saved.observedAt)>ageLimit) {
      await archive();
      size = 0;
    } else {
      header.observedAt = saved.observedAt;
      for (const line of records) {
        const item = JSON.parse(line);
        if (Array.isArray(item.rows) && item.rows.length<=100 && item.page===pages.length+1 &&
            item.page<=1000 && confirmations.length===0 && pages.at(-1)?.length!==0) {
          pages.push(item.rows);
        } else if (item.confirmed===confirmations.length+1 && pages.at(-1)?.length===0 && item.confirmed<=1000 &&
            confirmations.at(-1)?.length!==0 && Array.isArray(item.ids) && item.ids.length<=100 &&
            item.ids.every(id=>typeof id==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) {
          confirmations.push(item.ids);
          for (const product of item.differences??[]) {
            if (!item.ids.includes(product?.sourceId)) throw new Error('Invalid catalogue verification evidence');
            differences.set(product.sourceId,product);
          }
        } else throw new Error('Invalid catalogue checkpoint sequence');
      }
      if (lastCommit+1<content.length) {
        size = Buffer.byteLength(content.slice(0,lastCommit+1));
        await truncate(file,size);
      }
    }
  } catch (error) {
    if (error.code!=='ENOENT') throw error;
  }
  if (size===0) {
    const data = JSON.stringify(header)+'\n';
    await writeFile(file,data,{flag:'wx'});
    size = Buffer.byteLength(data);
  }
  const append = async record => {
    const data = JSON.stringify(record)+'\n';
    size+=Buffer.byteLength(data);
    if (size>cap) throw new Error('Catalogue checkpoint too large');
    await appendFile(file,data);
  };
  return {observedAt:header.observedAt,pages,confirmations,differences:[...differences.values()],
    savePage:(page,rows)=>append({page,rows}),
    saveConfirmation:(confirmed,ids,updates=[])=>append({confirmed,ids,...(updates.length && {differences:updates})}),
    finish:archive};
}

/** Recheck a changed tail without requesting pages whose product sets were
 * independently observed twice. Only admits a strict superset with matching
 * details on shared products. The archived provider evidence stays intact. */
export async function reconcileFinxplorCheckpoint(root, account, archiveName) {
  const key = createHash('sha256').update(account.tenantId+':'+account.providerAccountId).digest('hex');
  const prefix = 'finxplor-checkpoint-'+key;
  if (!new RegExp('^'+prefix+'-[a-f0-9-]{36}\\.jsonl$').test(archiveName)) throw new Error('Invalid catalogue archive');
  const archive = new URL(archiveName,root);
  const info = await stat(archive);
  if (!info.isFile() || info.size>cap) throw new Error('Invalid catalogue archive');
  const [header,...records] = (await readFile(archive,'utf8')).trimEnd().split('\n').map(JSON.parse);
  if (header.version!==1 || header.tenantId!==account.tenantId || header.providerAccountId!==account.providerAccountId ||
      !Number.isFinite(Date.parse(header.observedAt)) || Date.now()-Date.parse(header.observedAt)>ageLimit) {
    throw new Error('Invalid catalogue archive scope');
  }
  const first = records.filter(entry=>Array.isArray(entry.rows));
  const second = records.filter(entry=>Array.isArray(entry.ids));
  if (first.length+second.length!==records.length || !first.length || !second.length ||
      first.some(({page},i)=>page!==i+1) || second.some(({confirmed},i)=>confirmed!==i+1) ||
      first.at(-1).rows.length!==0 || second.at(-1).ids.length!==0) {
    throw new Error('Expected two terminal catalogue traversals');
  }
  const products = new Map(first.flatMap(entry=>entry.rows.map(product=>[product.sourceId,product])));
  const original = new Set(products.keys());
  const changed = second.flatMap(entry=>entry.differences??[]);
  if (!changed.length || changed.some(product=>original.has(product.sourceId))) {
    throw new Error('Cannot reuse verification with changed product details');
  }
  for (const product of changed) products.set(product.sourceId,product);
  const reference = new Set(second.flatMap(entry=>entry.ids));
  if (products.size!==reference.size || [...products.keys()].some(id=>!reference.has(id))) {
    throw new Error('Verification is not a superset of the original catalogue');
  }

  let sharedPages = 0;
  const left = new Set(), right = new Set(), delta = new Set();
  const add = (own, other, ids) => {
    for (const id of ids) {
      if (own.has(id)) continue;
      own.add(id);
      if (other.has(id)) delta.delete(id);
      else delta.add(id);
    }
  };
  for (let i=0;i<Math.min(first.length,second.length)-1;i++) {
    add(left,right,first[i].rows.map(product=>product.sourceId));
    add(right,left,second[i].ids);
    if (!delta.size) sharedPages=i+1;
  }
  if (!sharedPages) throw new Error('No shared provider pages to reuse');
  const checkpoint = [
    {...header,derivedFrom:archiveName,reconciliationPrefix:sharedPages},
    ...second.map(({ids},i)=>({page:i+1,rows:ids.map(id=>products.get(id))})),
    ...first.slice(0,sharedPages).map(({rows},i)=>({confirmed:i+1,ids:rows.map(product=>product.sourceId)})),
  ].map(record=>JSON.stringify(record)).join('\n')+'\n';
  if (Buffer.byteLength(checkpoint)>cap) throw new Error('Catalogue checkpoint too large');
  await writeFile(new URL(prefix+'.jsonl',root),checkpoint,{flag:'wx'});
  return {products:products.size,sharedPages,nextPage:sharedPages+1};
}
