import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { PlatformApp } from './PlatformApp';
import './styles.css';

// Fictional data is loaded only through the explicit review route.
const Preview = lazy(() => import('./App'));
const preview = window.location.pathname === '/preview' || window.location.pathname.startsWith('/preview/');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter basename={preview ? '/preview' : '/'}>
    <Suspense fallback={<p role="status">Loading staff workspace…</p>}>
      {preview ? <Preview /> : <PlatformApp />}
    </Suspense>
  </BrowserRouter></React.StrictMode>
);
