import { createHash } from 'node:crypto';

export const CLAIM = 'https://claims.nukhbapay.com/principal';
export const SOURCE_SHA256 = '19e7b88f8eabb0401bbfefb46c2152118dbc2f67cf51ebc7c90ac0f763e38784';
export const CONFIG_NAMES = Object.freeze(['NUKHBAPAY_STAFF_PORTAL_CLIENT_ID',
  'NUKHBAPAY_STAFF_DATABASE_CONNECTION_ID', 'NUKHBAPAY_STAFF_API_AUDIENCE']);
export const OPERATIONS = Object.freeze(['CREATE', 'IMPORT', 'PASSWORD_RESET', 'EMAIL_VERIFY',
  'MFA_RESET', 'RESTORE', 'LINK', 'UNLINK', 'PRIMARY_USER', 'DELEGATE']);
export const SECTIONS = Object.freeze(['domain', 'actions', 'rules', 'capabilities', 'management', 'mfa', 'rollback', 'release']);
export const MAX_BYTES = 131072;
export const invalid = () => new Error('Sanitized development security evidence rejected');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = value => sha256(canonical(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const manifest = freeze({
  format: 'nukhbapay-development-action-v1', version: 'STAFF_HUMAN_PRINCIPAL_DEV_V1', runtime: 'node22',
  trigger: 'post-login', dependencies: [], sourceSha256: SOURCE_SHA256, artifactSha256: SOURCE_SHA256,
  configurationNames: CONFIG_NAMES, claim: CLAIM, value: 'human',
  conditions: { callback: 'https://localhost:3001/auth/callback', protocol: 'oidc-basic-profile',
    responseType: ['code'], responseMode: 'query', requestedScopes: ['openid'], strategy: 'auth0',
    exactClientConnectionAudience: true, delegationAndLinkingDenied: true },
  deployable: false, authenticationAllowed: false,
});
export const manifestBytes = () => Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
export const MANIFEST_SHA256 = sha256(manifestBytes());

/** Native JSON syntax plus duplicate-key detection, including escaped aliases. No input in errors. */
export function parseStrictJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) throw invalid();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  let i = 0, nodes = 0;
  const space = () => { while (/[\t\r\n ]/.test(text[i] ?? '\0')) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw invalid();
  }
  function walk(depth) {
    if (++nodes > 20000 || depth > 12) throw invalid();
    space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        space(); const key = string();
        if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid();
        keys.add(key); space(); if (text[i++] !== ':') throw invalid(); walk(depth + 1); space();
        if (text[i++] === '}') break;
      }
    } else if (text[i] === '[') {
      i++; space(); if (text[i] === ']') { i++; return; }
      while (true) { walk(depth + 1); space(); if (text[i++] === ']') break; }
    } else if (text[i] === '"') string();
    else { const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
      if (!match) throw invalid(); i += match[0].length; }
  }
  walk(0); space(); if (i !== text.length) throw invalid(); return parsed;
}

export const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export const nullableHash = x => x === null || hash(x);
export const alias = x => typeof x === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(x);
export const flag = x => x === null || typeof x === 'boolean';
export const integer = x => Number.isSafeInteger(x) && x >= 0 && x <= 10000;
export const choice = (...values) => x => values.includes(x);
export const list = predicate => x => Array.isArray(x) && x.length <= 256 && x.every(predicate);
export function object(value, fields, optional = false) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(fields, key)) ||
      (!optional && Object.keys(fields).some(key => !Object.hasOwn(value, key))) ||
      Object.entries(value).some(([key, item]) => !fields[key](item))) throw invalid();
  return true;
}
export function unique(items, key = x => x) {
  if (new Set(items.map(key)).size !== items.length) throw invalid();
}
export function result(checks) {
  const status = checks.some(x => x.status === 'FAILED') ? 'FAILED' :
    checks.some(x => x.status === 'UNKNOWN') ? 'UNKNOWN' : 'VERIFIED';
  return { status, reasons: [...new Set(checks.filter(x => x.status !== 'VERIFIED').map(x => x.code))].sort() };
}
export const check = (condition, code) => ({ status: condition === true ? 'VERIFIED' : condition === null ? 'UNKNOWN' : 'FAILED', code });
export const reviewed = x => [check(x.recordRef === null ? null : true, 'RECORD_REFERENCE_MISSING')];
export const complete = (x, code = 'INVENTORY_INCOMPLETE') => check(x === true ? true : null, code);
export function safeReport(gates, extra = {}) {
  return { basis: 'OFFLINE_SUPPLIED_EVIDENCE', ...result(Object.values(gates).map(x => ({ status: x.status, code: 'GATES_NOT_CLOSED' }))),
    gates, ...extra, tenantAcceptance: 'NOT_ESTABLISHED', deployable: false, authenticationAllowed: false, changeAllowed: false };
}
