export type SessionState =
  | { kind: 'loading' | 'anonymous' | 'unavailable' | 'forbidden' }
  | { kind: 'authenticated'; csrfToken: string };

// Only the existing same-origin BFF is contacted. Cookies are HttpOnly; CSRF stays in memory.
export async function readSession(signal?: AbortSignal): Promise<SessionState> {
  try {
    const response = await fetch('/auth/session', {
      credentials: 'same-origin', cache: 'no-store', signal: signal ?? null,
    });
    if (response.status === 401) return { kind: 'anonymous' };
    if (response.status === 403) return { kind: 'forbidden' };
    if (!response.ok) return { kind: 'unavailable' };
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null && 'authenticated' in data && data.authenticated === true &&
      'csrfToken' in data && typeof data.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)) {
      return { kind: 'authenticated', csrfToken: data.csrfToken };
    }
  } catch { /* Render a safe retry state, never a fabricated session. */ }
  return { kind: 'unavailable' };
}

/** The allowlist comes from server-rendered HTML configuration, never logout JSON. */
export function providerLogoutDestination(value:unknown,expected:string|undefined,origin:string):string|undefined {
  if(typeof value!=='string'||!expected||value!==expected)return undefined;
  try {
    const url=new URL(value);
    if(url.href!==value||url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.pathname!=='/v2/logout' ||
      new URL(origin).origin!==origin||url.searchParams.getAll('client_id').length!==1||!url.searchParams.get('client_id')||
      url.searchParams.getAll('returnTo').length!==1||url.searchParams.get('returnTo')!==origin+'/auth/logged-out'||
      [...url.searchParams.keys()].some(key=>key!=='client_id'&&key!=='returnTo'))return undefined;
    return value;
  }catch{return undefined;}
}

export function serverLogoutPolicy(document:Pick<Document,'querySelectorAll'>):string|undefined {
  const entries=document.querySelectorAll('meta[name="nukhbapay-provider-logout"]');
  return entries.length===1?entries[0]?.getAttribute('content')??undefined:undefined;
}

export type LogoutResult={readonly ok:true;readonly destination:string}|{readonly ok:false};
export async function signOut(csrfToken: string,expectedProviderUrl?:string,origin?:string): Promise<LogoutResult> {
  try {
    const response = await fetch('/auth/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: '{}',
    });
    if(response.status===204)return {ok:true,destination:'/auth/logged-out'};
    if(response.status!==200||!expectedProviderUrl||!origin)return {ok:false};
    const data:unknown=await response.json();
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||!('logoutUrl' in data))return {ok:false};
    const destination=providerLogoutDestination(data.logoutUrl,expectedProviderUrl,origin);
    return destination?{ok:true,destination}:{ok:false};
  } catch { return {ok:false}; }
}
