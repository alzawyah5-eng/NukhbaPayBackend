import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LockKeyhole, Menu, X } from 'lucide-react';
import { Button, Notice, Panel } from './components/UI';
import { readSession, readLoginPath, sessionExpiryDelay, signOut, serverLogoutPolicy, type SessionState } from './session';
import { navigation, PageHeading } from './components/AppShell';

export function PlatformApp() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [loginPath,setLoginPath]=useState<'/auth/login'|undefined>();
  const location = useLocation();
  useEffect(() => {
    const controller = new AbortController();
    setSession({ kind: 'loading' });
    void readSession(controller.signal).then(value => { if (!controller.signal.aborted) setSession(value); });
    setLoginPath(undefined);
    void readLoginPath(controller.signal).then(value=>{if(!controller.signal.aborted)setLoginPath(value);});
    return () => controller.abort();
  }, [attempt, location.pathname]);
  useEffect(()=>{
    const refresh=()=>setAttempt(n=>n+1);
    window.addEventListener('focus',refresh);
    return ()=>window.removeEventListener('focus',refresh);
  },[]);
  useEffect(()=>{
    if(session.kind!=='authenticated')return;
    const timer=setTimeout(()=>setSession({kind:'anonymous'}),sessionExpiryDelay(session.profile.expiresAtMs));
    return ()=>clearTimeout(timer);
  },[session]);
  async function logout() {
    if (session.kind !== 'authenticated') return;
    setBusy(true); setError('');
    const result=await signOut(session.csrfToken,serverLogoutPolicy(document),window.location.origin);
    if (result.ok) window.location.assign(result.destination);
    else { setError('Sign out could not be confirmed. Please retry.'); setBusy(false); }
  }
  if (session.kind !== 'authenticated') return <div className="login-layout">
    <aside className="login-brand"><div className="login-logo">NukhbaPay</div><div className="login-brand-center"><h1>Secure operations.<br/>Clear control.</h1><p>Staff identities, approved access, and audit-ready operations — together in one protected workspace.</p></div></aside>
    <main className="login-form-area"><div className="login-form"><span className="eyebrow">STAFF PORTAL</span><h1>Welcome back</h1><p>Use your organization's approved sign-in method.</p>
      <div role="status" aria-live="polite"><Notice tone="warning">{session.kind === 'loading' ? 'Checking staff session…' : session.kind === 'anonymous' ? loginPath ? 'Your session is absent or expired. Continue to secure sign in.' : 'Your session is absent or expired. Staff sign-in is currently unavailable.' : session.kind === 'forbidden' ? 'Access to this staff workspace was denied.' : 'The staff session service is unavailable. Staff sign-in is currently disabled.'}</Notice></div>
      <div className="form-field"><label htmlFor="work-email">Work email</label><input id="work-email" type="email" placeholder="name@organization.com" disabled/></div>
      <Button disabled={!loginPath||session.kind!=='anonymous'} onClick={()=>{if(loginPath&&session.kind==='anonymous')window.location.assign(loginPath);}}>Continue with secure sign in</Button>{session.kind !== 'loading' && <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry session check</Button>}
      <div className="login-rule"/><p className="login-mfa"><LockKeyhole size={16}/> Multi-factor authentication is required for access.</p>
    </div><p className="login-footer">Authorized staff only · Access must be monitored and logged</p></main>
  </div>;
  const item = navigation.find(n => n.path === location.pathname);
  const title = location.pathname === '/' ? 'Staff overview' : item?.label ?? ( /^\/staff\/[^/]+$/.test(location.pathname) ? 'Staff profile' : 'Page not found');
  return <div className="app-layout">
    {open && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setOpen(false)}/>}
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`} aria-label="Main navigation">
      <div className="sidebar-brand"><img src="/nukhbapay-original-logo-reference.png" alt="NukhbaPay"/><button className="close-mobile icon-button" aria-label="Close menu" onClick={() => setOpen(false)}><X/></button></div>
      <div className="side-caption">STAFF WORKSPACE</div><nav className="side-nav">{navigation.filter(n=>session.profile.navigation.some(path=>path===n.path)).map(n => <NavLink key={n.path} to={n.path} end onClick={() => setOpen(false)} className={({isActive}) => `side-link ${isActive ? 'side-link--active' : ''}`}><n.icon size={17}/>{n.label}</NavLink>)}</nav>
      <div className="sidebar-bottom">Staff workspace</div>
    </aside><div className="app-right"><header className="topbar"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu/></button><span>Staff workspace</span><div className="topbar-actions"><Button variant="secondary" disabled={busy} onClick={() => void logout()}>{busy ? 'Signing out…' : 'Sign out'}</Button></div></header>
      <main className="main-content"><PageHeading title={title} subtitle="Centralized staff management"/>{error && <div role="alert"><Notice tone="warning">{error}</Notice></div>}<Panel title="Current staff"><p>Staff ID: {session.profile.staffId}</p><p>Tenant: {session.profile.tenantId??'Platform self access'}</p></Panel>{location.pathname!=='/'&&!session.profile.navigation.some(path=>path===location.pathname)?<div role="alert"><Notice tone="warning">This page is not authorized or available for this session.</Notice></div>:<Panel title="Service unavailable"><Notice>Staff management data and actions are not available in this platform build. No management permissions have been granted.</Notice><Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry session check</Button></Panel>}</main>
    </div></div>;
}
