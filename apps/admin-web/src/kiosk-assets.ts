import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { BrowserAssets } from './browser-assets.js';

const types: Readonly<Record<string,string>> = {
  '.css':'text/css', '.js':'text/javascript', '.jpg':'image/jpeg', '.png':'image/png',
  '.svg':'image/svg+xml', '.ttf':'font/ttf',
};

export function loadKioskAssets(directory:string): BrowserAssets {
  const assets = new Map<string,{body:Buffer;type:string}>();
  const add = (url:string, file:string, type:string) => {
    if(!lstatSync(file).isFile())throw new Error('Invalid kiosk build');
    assets.set(url,{body:readFileSync(file),type});
  };
  add('/kiosk',join(directory,'kiosk.html'),'text/html');
  for (const collection of ['kiosk-static','kiosk-assets']) {
    const root = join(directory,collection);
    if(!lstatSync(root).isDirectory())throw new Error('Invalid kiosk build');
    for (const file of readdirSync(root)) {
      const extension=extname(file);
      if (!/^[A-Za-z0-9_.-]+$/.test(file) || !(collection==='kiosk-static' ? ['.css','.js'] : ['.jpg','.png','.svg','.ttf']).includes(extension)) continue;
      add('/'+collection+'/'+file,join(root,file),types[extension]!);
    }
  }
  return assets;
}
