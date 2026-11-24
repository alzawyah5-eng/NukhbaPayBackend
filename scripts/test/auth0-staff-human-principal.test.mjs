import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onExecutePostLogin } from '../auth0/staff-human-principal.cjs';

// Synthetic event context, not tenant IDs, credentials or provider acceptance evidence.
const claim = 'https://claims.nukhbapay.com/principal';
const valid = () => ({
  secrets: {
    NUKHBAPAY_STAFF_PORTAL_CLIENT_ID: 'synthetic-staff-portal',
    NUKHBAPAY_STAFF_DATABASE_CONNECTION_ID: 'con_synthetic_staff',
    NUKHBAPAY_STAFF_API_AUDIENCE: 'https://api.synthetic.invalid/staff',
  },
  client: { client_id: 'synthetic-staff-portal' },
  connection: { id: 'con_synthetic_staff', strategy: 'auth0' },
  resource_server: { identifier: 'https://api.synthetic.invalid/staff' },
  transaction: { protocol: 'oidc-basic-profile', response_type: ['code'], response_mode: 'query',
    redirect_uri: 'https://localhost:3001/auth/callback', requested_scopes: ['openid'] },
  user: { user_id: 'auth0|synthetic-human' },
});
const run = async event => {
  const claims = [], denials = [];
  // Any unapproved Action API access (ID token, MFA, roles, metadata, scopes) fails the test.
  const guard = object => new Proxy(object, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `Unexpected Action API: ${String(key)}`); return target[key];
  } });
  const api = guard({
    access: guard({ deny: reason => { denials.push(reason); } }),
    accessToken: guard({ setCustomClaim: (...args) => { claims.push(args); } }),
  });
  const before = structuredClone(event);
  await onExecutePostLogin(event, api);
  assert.deepEqual(event, before, 'The event must not be mutated');
  return { claims, denials };
};

test('only an exact scoped staff database authorization-code event receives the proposed claim', async () => {
  assert.deepEqual(await run(valid()), { claims: [[claim, 'human']], denials: [] });
  const event = valid(); event.secrets.NUKHBAPAY_STAFF_API_AUDIENCE = 'urn:nukhbapay:synthetic:staff';
  event.resource_server.identifier = event.secrets.NUKHBAPAY_STAFF_API_AUDIENCE;
  assert.deepEqual(await run(event), { claims: [[claim, 'human']], denials: [] });
});

test('unrelated or unknown clients never receive the human claim or a tenant-wide denial', async t => {
  const cases = [
    ['unrelated client', e => { e.client.client_id = 'unrelated-app'; }],
    ['missing client', e => { delete e.client; }],
    ['client name cannot bind', e => { e.client = { name: 'synthetic-staff-portal' }; }],
    ['missing secrets', e => { delete e.secrets; }],
    ...[undefined, null, '', ' ', 'synthetic-staff-portal ', ['synthetic-staff-portal'], 'x'.repeat(129)]
      .map((value, i) => [`invalid client secret ${i}`, e => { e.secrets.NUKHBAPAY_STAFF_PORTAL_CLIENT_ID = value; }]),
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const event = valid(); change(event); assert.deepEqual(await run(event), { claims: [], denials: [] });
  });
  assert.deepEqual(await run(undefined), { claims: [], denials: [] });
  assert.deepEqual(await run(null), { claims: [], denials: [] });
});

test('target staff client fails closed on wrong or missing trust context', async t => {
  const cases = [
    ['wrong connection', e => { e.connection.id = 'con_other'; }],
    ['missing connection', e => { delete e.connection; }],
    ['connection name cannot bind', e => { e.connection = { name: 'con_synthetic_staff', strategy: 'auth0' }; }],
    ['social strategy', e => { e.connection.strategy = 'google-oauth2'; }],
    ['enterprise strategy', e => { e.connection.strategy = 'waad'; }],
    ['missing user', e => { delete e.user; }],
    ...[undefined, null, '', 'auth0|', 'auth0|bad user', 'auth0|' + 'x'.repeat(512),
      'synthetic-client@clients', 'auth0|synthetic-client@clients', 'google-oauth2|human', 'agt_synthetic']
      .map((value, i) => [`invalid subject ${i}`, e => { e.user.user_id = value; }]),
    ['missing transaction', e => { delete e.transaction; }],
    ...[undefined, null, 'oauth2-refresh-token', 'oauth2-token-exchange', 'client_credentials',
      'oauth2-resource-owner', 'oauth2-password', 'oidc-implicit-profile', 'oidc-hybrid-profile',
      'oauth2-device-code', 'oidc-ciba', 'samlp', 'wsfed', 'future-protocol']
      .map(value => [`unsupported protocol ${value}`, e => { e.transaction.protocol = value; }]),
    ...[undefined, null, 'code', [], ['token'], ['code', 'id_token'], ['code', 'code']]
      .map((value, i) => [`invalid response type ${i}`, e => { e.transaction.response_type = value; }]),
    ['response mode', e => { e.transaction.response_mode = 'form_post'; }],
    ['callback alias', e => { e.transaction.redirect_uri += '/'; }],
    ['foreign callback', e => { e.transaction.redirect_uri = 'https://attacker.invalid/auth/callback'; }],
    ...[undefined, null, 'openid', [], ['offline_access'], ['openid', 'offline_access'], ['openid', 'write:roles']]
      .map((value, i) => [`invalid scopes ${i}`, e => { e.transaction.requested_scopes = value; }]),
    ['missing API', e => { delete e.resource_server; }],
    ['wrong API', e => { e.resource_server.identifier = 'https://api.other.invalid/staff'; }],
    ['API alias', e => { e.resource_server.identifier += '/'; }],
    ...['NUKHBAPAY_STAFF_DATABASE_CONNECTION_ID', 'NUKHBAPAY_STAFF_API_AUDIENCE'].flatMap(key =>
      [undefined, null, '', ' ', 'bad\nvalue', [], 'x'.repeat(513)]
        .map((value, i) => [`invalid ${key} ${i}`, e => { e.secrets[key] = value; }])),
    ...['not-a-url', 'http://api.invalid/staff', 'https://api.invalid/staff?q=1', 'https://api.invalid/staff#x', 'https://user:pass@api.invalid/staff']
      .map(value => [`invalid audience URL ${value}`, e => { e.secrets.NUKHBAPAY_STAFF_API_AUDIENCE = value; }]),
    ...[null, {}, { agent_id: 'agt_synthetic' }].map((value, i) => [`agent ${i}`, e => { e.agent = value; }]),
    ...[null, {}, { sub: 'delegator' }].map((value, i) => [`session actor ${i}`, e => { e.session = { actor: value }; }]),
    ...['actor', 'actor_token_type', 'subject_token_type', 'linking_id'].flatMap(key =>
      [null, {}, 'delegation'].map((value, i) => [`transaction ${key} ${i}`, e => { e.transaction[key] = value; }])),
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const event = valid(); change(event);
    assert.deepEqual(await run(event), { claims: [], denials: ['Staff principal classification denied'] });
  });
});

test('browser metadata, email, roles and request fields cannot replace trusted context', async () => {
  const event = valid();
  event.user.user_metadata = { principal: 'human', roles: ['admin'], connection_id: event.connection.id };
  event.user.app_metadata = { principal: 'machine', roles: ['admin'] };
  event.user.email = 'admin@nukhbapay.com'; event.user.email_verified = true;
  event.request = { query: { client_id: event.client.client_id, connection: event.connection.id, audience: event.resource_server.identifier } };
  event.connection.id = 'unrelated-connection';
  assert.equal((await run(event)).claims.length, 0);
  // Authentication methods are deliberately not fabricated or required by this classification Action.
  const noMfa = valid(); noMfa.authentication = { methods: [{ name: 'pwd' }] };
  assert.deepEqual(await run(noMfa), { claims: [[claim, 'human']], denials: [] });
});
