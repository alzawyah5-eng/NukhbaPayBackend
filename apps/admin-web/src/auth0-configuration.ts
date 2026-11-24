import { validateAuth0Configuration, type Auth0Configuration } from './auth0.js';

// Matches the existing CLI listener. No callback, tenant or issuer comes from a browser request.
export const STAFF_PORTAL_PORT = 3001;
export const STAFF_PORTAL_ORIGIN = `https://localhost:${STAFF_PORTAL_PORT}`;

/** Preparation only: this parser is deliberately not called by CLI composition. */
export function readPendingAuth0Configuration(env:Readonly<Record<string,string|undefined>>):Readonly<Auth0Configuration> {
  if(env['NUKHBAPAY_ENVIRONMENT']!=='development')throw new Error('Staff authentication configuration unavailable');
  try {
    const required=(name:string)=>{const value=env[name];if(!value)throw new Error();return value;};
    const audienceMode=env['NUKHBAPAY_STAFF_AUTH0_ACCESS_TOKEN_AUDIENCE_MODE'] ?? 'api-only';
    if(audienceMode!=='api-only' && audienceMode!=='api-and-userinfo')throw new Error();
    return validateAuth0Configuration({
      issuer:required('NUKHBAPAY_STAFF_AUTH0_ISSUER'),clientId:required('NUKHBAPAY_STAFF_AUTH0_CLIENT_ID'),
      clientSecret:required('NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET'),audience:required('NUKHBAPAY_STAFF_AUTH0_AUDIENCE'),
      staffKindClaim:required('NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM'),tenantId:required('NUKHBAPAY_STAFF_AUTH0_TENANT_ID'),
      accessTokenAudienceMode:audienceMode,
      callbackUrl:STAFF_PORTAL_ORIGIN+'/auth/callback',
    });
  }catch{throw new Error('Staff authentication configuration unavailable');}
}
