import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { readAwsStagingAuth0Configuration, readPendingAuth0Configuration, STAFF_PORTAL_ORIGIN } from '../src/auth0-configuration.js';
import { validateAuth0Configuration } from '../src/auth0.js';
import { config } from './fixtures/auth0-fixture.js';

test('pending development configuration is server-only, exact, redacted and cannot select a callback',()=>{
  const env={NUKHBAPAY_ENVIRONMENT:'development',NUKHBAPAY_STAFF_AUTH0_ISSUER:config.issuer,
    NUKHBAPAY_STAFF_AUTH0_CLIENT_ID:config.clientId,NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET:config.clientSecret,
    NUKHBAPAY_STAFF_AUTH0_AUDIENCE:config.audience,NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM:config.staffKindClaim,
    NUKHBAPAY_STAFF_AUTH0_TENANT_ID:config.tenantId};
  const parsed=readPendingAuth0Configuration({...env,NUKHBAPAY_STAFF_AUTH0_CALLBACK_URL:'https://attacker.invalid'});
  assert.equal(parsed.callbackUrl,STAFF_PORTAL_ORIGIN+'/auth/callback');
  assert.equal(parsed.clientSecret===config.clientSecret,true);
  assert.equal(parsed.accessTokenAudienceMode,'api-only');
  assert.equal(readPendingAuth0Configuration({...env,NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM:'https://claims.nukhbapay.com/principal'}).staffKindClaim,'https://claims.nukhbapay.com/principal');
  assert.equal(readPendingAuth0Configuration({...env,NUKHBAPAY_STAFF_AUTH0_ACCESS_TOKEN_AUDIENCE_MODE:'api-only'}).accessTokenAudienceMode,'api-only');
  assert.equal(readPendingAuth0Configuration({...env,NUKHBAPAY_STAFF_AUTH0_ACCESS_TOKEN_AUDIENCE_MODE:'api-and-userinfo'}).accessTokenAudienceMode,'api-and-userinfo');
  for(const mode of ['', 'true', 'API-AND-USERINFO', '["api-and-userinfo"]', 'api-and-userinfo ']) {
    assert.throws(()=>readPendingAuth0Configuration({...env,NUKHBAPAY_STAFF_AUTH0_ACCESS_TOKEN_AUDIENCE_MODE:mode}),{message:'Staff authentication configuration unavailable'});
  }
  for(const output of [JSON.stringify(parsed),inspect(parsed)])assert.equal(output.includes(config.clientSecret),false);
  for(const key of Object.keys(env))assert.throws(()=>readPendingAuth0Configuration({...env,[key]:''}),{message:'Staff authentication configuration unavailable'});
  for(const overrides of [{NUKHBAPAY_ENVIRONMENT:'production'},{NUKHBAPAY_STAFF_AUTH0_ISSUER:'http://auth.synthetic.invalid/'},
    {NUKHBAPAY_STAFF_AUTH0_TENANT_ID:'forged'},{NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET:'short'}])assert.throws(()=>readPendingAuth0Configuration({...env,...overrides}));
});

test('staging configuration pins the approved HTTPS hostname and rejects production and forwarded caller choices',()=>{
  const env={NODE_ENV:'production',NUKHBAPAY_ENVIRONMENT:'aws-staging',NUKHBAPAY_STAFF_AUTH0_ISSUER:config.issuer,
    NUKHBAPAY_STAFF_AUTH0_CLIENT_ID:config.clientId,NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET:config.clientSecret,
    NUKHBAPAY_STAFF_AUTH0_AUDIENCE:config.audience,NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM:config.staffKindClaim,
    NUKHBAPAY_STAFF_AUTH0_TENANT_ID:config.tenantId,NUKHBAPAY_STAFF_AUTH0_CALLBACK_URL:'https://untrusted.invalid/auth/callback'};
  const parsed=readAwsStagingAuth0Configuration(env);
  assert.equal(parsed.callbackUrl,'https://staging.nukhbapay.com/auth/callback');
  assert.equal(JSON.stringify(parsed).includes(config.clientSecret),false);
  assert.throws(()=>readAwsStagingAuth0Configuration({...env,NUKHBAPAY_ENVIRONMENT:'production'}));
  assert.throws(()=>readAwsStagingAuth0Configuration({...env,NODE_ENV:'development'}));
  assert.throws(()=>validateAuth0Configuration({...config,callbackUrl:parsed.callbackUrl}));
  assert.throws(()=>validateAuth0Configuration({...config,deployment:'aws-staging',callbackUrl:'https://nukhbapay.com/auth/callback'}));
  assert.throws(()=>validateAuth0Configuration({...config,deployment:'aws-staging',callbackUrl:parsed.callbackUrl,tenantId:null}));
});
