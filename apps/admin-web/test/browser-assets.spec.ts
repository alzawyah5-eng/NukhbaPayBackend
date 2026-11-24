import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserAsset, developmentPreviewEnabled, loadBrowserAssets } from '../src/browser-assets.js';

test('built UI serves deep links and search but never source, maps, unknown APIs or traversal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nukhbapay-staff-assets-'));
  try {
    mkdirSync(join(directory, 'assets'));
    mkdirSync(join(directory, '.vite'));
    writeFileSync(join(directory, '.vite', 'manifest.json'), JSON.stringify({
      'index.html': { file: 'assets/index-123.js', dynamicImports: ['src/App.tsx'] },
      'src/App.tsx': { file: 'assets/App-demo.js', imports: ['index.html'] },
    }));
    writeFileSync(join(directory, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(directory, 'nukhbapay-original-logo-reference.png'), 'logo');
    writeFileSync(join(directory, 'assets', 'index-123.js'), 'export {};');
    writeFileSync(join(directory, 'assets', 'App-demo.js'), 'const demoStaff = "Maya Rahman";');
    writeFileSync(join(directory, '.env'), 'never serve');
    const assets = loadBrowserAssets(directory);
    for (const path of ['/', '/login', '/staff/invite', '/staff/staff-123', '/staff?q=test', '/preview',
      '/preview/overview', '/preview/staff/staff-123', '/auth/logged-out']) {
      assert.equal(browserAsset(assets, path, true)?.type, 'text/html', path);
    }
    for (const path of ['/management', '/management/overview', '/management/staff/invite']) {
      assert.equal(browserAsset(assets, path)?.type, 'text/html', path);
    }
    for (const path of ['/management/api/session', '/management/preview/staff', '/management/../.env']) {
      assert.equal(browserAsset(assets, path), undefined, path);
    }
    assert.equal(browserAsset(assets, '/assets/index-123.js')?.type, 'text/javascript');
    for (const path of ['/preview', '/preview/overview', '/preview/staff?q=test', '/assets/App-demo.js']) {
      assert.equal(browserAsset(assets, path), undefined, path);
      assert.ok(browserAsset(assets, path, true), path);
    }
    for (const path of ['/.env', '/index.html', '/src/main.tsx', '/assets/index-123.js.map',
      '/assets/../index.html', '/%2e%2e/.env', '/staff/%2fsecret', '/auth/session', '/auth/callback',
      '/staff-api/v1/staff', '/unknown', '//overview', '/overview/']) assert.equal(browserAsset(assets, path), undefined, path);
    writeFileSync(join(directory, 'assets', 'index-123.js.map'), 'source map');
    assert.throws(() => loadBrowserAssets(directory), /Unexpected staff UI asset/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('preview requires exact server-side opt-in and explicit development environment', () => {
  for (const environment of [undefined, '', 'production', 'test', 'Development']) {
    assert.equal(developmentPreviewEnabled({ NODE_ENV: environment, NUKHBAPAY_STAFF_UI_PREVIEW: 'enabled' }), false);
  }
  for (const flag of [undefined, '', 'disabled', 'true', '1']) {
    assert.equal(developmentPreviewEnabled({ NODE_ENV: 'development', NUKHBAPAY_STAFF_UI_PREVIEW: flag }), false);
  }
  assert.equal(developmentPreviewEnabled({ NODE_ENV: 'development', NUKHBAPAY_STAFF_UI_PREVIEW: 'enabled' }), true);
});
