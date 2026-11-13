import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface BrowserAsset { readonly body: Buffer; readonly type: string; readonly previewOnly?: boolean }
export type BrowserAssets = ReadonlyMap<string, BrowserAsset>;
export function developmentPreviewEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['NODE_ENV'] === 'development' && env['NUKHBAPAY_STAFF_UI_PREVIEW'] === 'enabled';
}
const routes = new Set(['/', '/login', '/overview', '/staff', '/staff/invite', '/roles', '/departments',
  '/access-requests', '/security', '/sessions', '/audit', '/reports', '/settings', '/auth/logged-out']);

export function isBrowserRoute(path: string): boolean {
  const route = path === '/preview' ? '/' : path.startsWith('/preview/') ? path.slice(8) : path;
  return routes.has(route) || /^\/staff\/[A-Za-z0-9_-]{1,128}$/.test(route);
}

/** Read only known Vite outputs at startup. Request URLs never become filesystem paths. */
export function loadBrowserAssets(directory: string): BrowserAssets {
  const assets = new Map<string, BrowserAsset>();
  // Only the entry's static dependency closure is public by default. Dynamic chunks
  // (including the demo records) require the server's development preview policy.
  const manifest: Record<string, { file: string; imports?: string[]; css?: string[]; assets?: string[] }> =
    JSON.parse(readFileSync(join(directory, '.vite', 'manifest.json'), 'utf8'));
  const core = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk || typeof chunk.file !== 'string') throw new Error('Invalid staff UI manifest');
    core.add(chunk.file);
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) core.add(file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  visit('index.html');
  function add(url: string, relative: string, type: string, previewOnly = false) {
    const path = join(directory, relative);
    if (!lstatSync(path).isFile()) throw new Error('Invalid staff UI build');
    assets.set(url, Object.freeze({ body: readFileSync(path), type, previewOnly }));
  }
  add('/index.html', 'index.html', 'text/html');
  add('/nukhbapay-original-logo-reference.png', 'nukhbapay-original-logo-reference.png', 'image/png');
  if (!lstatSync(join(directory, 'assets')).isDirectory() || lstatSync(join(directory, 'assets')).isSymbolicLink()) throw new Error('Invalid staff UI build');
  for (const file of readdirSync(join(directory, 'assets'))) {
    if (!/^[A-Za-z0-9_-]+\.(?:js|css)$/.test(file)) throw new Error('Unexpected staff UI asset');
    add(`/assets/${file}`, join('assets', file), file.endsWith('.css') ? 'text/css' : 'text/javascript', !core.has(`assets/${file}`));
  }
  return assets;
}

export function browserAsset(assets: BrowserAssets, url: string, previewEnabled = false): BrowserAsset | undefined {
  // Reject encoded/ambiguous paths. Allow query strings for SPA search only.
  const path = url.split('?')[0]!;
  if (!previewEnabled && (path === '/preview' || path.startsWith('/preview/'))) return undefined;
  if (isBrowserRoute(path)) return assets.get('/index.html');
  const asset = assets.get(url === '/index.html' ? '' : url);
  return asset?.previewOnly && !previewEnabled ? undefined : asset;
}
