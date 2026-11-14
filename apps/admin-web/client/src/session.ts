export type SessionState =
  | { kind: 'loading' | 'anonymous' | 'unavailable' | 'forbidden' }
  | { kind: 'authenticated'; csrfToken: string; profile: StaffProfile };

export interface StaffProfile {
  readonly staffId:string; readonly tenantId:string|null; readonly expiresAtMs:number;
  readonly navigation:readonly ['/overview'];
}

export async function readLoginPath(signal?:AbortSignal):Promise<'/auth/login'|undefined> {
  try {
    const response=await fetch('/auth/config',{credentials:'same-origin',cache:'no-store',signal:signal??null});
    if(!response.ok)return undefined;
    const data:unknown=await response.json();
    return data && typeof data==='object' && !Array.isArray(data) && Object.keys(data).length===1 &&
      'loginPath' in data && data.loginPath==='/auth/login'?'/auth/login':undefined;
  }catch{return undefined;}
}

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
      const self=await fetch('/auth/me',{credentials:'same-origin',cache:'no-store',signal:signal??null});
      if(self.status===401)return {kind:'anonymous'};
      if(self.status===403)return {kind:'forbidden'};
      if(!self.ok)return {kind:'unavailable'};
      const profile:unknown=await self.json(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if(profile && typeof profile==='object' && !Array.isArray(profile) && Object.keys(profile).sort().join(',')==='expiresAtMs,navigation,staffId,tenantId' &&
        'staffId' in profile && typeof profile.staffId==='string' && uuid.test(profile.staffId) &&
        'tenantId' in profile && (profile.tenantId===null||typeof profile.tenantId==='string'&&uuid.test(profile.tenantId)) &&
        'expiresAtMs' in profile && typeof profile.expiresAtMs==='number' && Number.isSafeInteger(profile.expiresAtMs)&&profile.expiresAtMs>0 &&
        'navigation' in profile && Array.isArray(profile.navigation) && profile.navigation.length===1 && profile.navigation[0]==='/overview') {
        return {kind:'authenticated',csrfToken:data.csrfToken,profile:profile as unknown as StaffProfile};
      }
    }
  } catch { /* Render a safe retry state, never a fabricated session. */ }
  return { kind: 'unavailable' };
}

export function sessionExpiryDelay(expiresAtMs:number,now=Date.now()):number {
  return Math.max(0,Math.min(expiresAtMs-now,2_147_483_647));
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
