import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyIronGateCatalogueRead, qualifySslCatalogueRead } from '../src/index.ts';

const account={tenantId:'00000000-0000-4000-8000-000000000001',providerAccountId:'00000000-0000-4000-8000-000000000002'};
const origin='https://catalogue.fixture.invalid';
const ssl={account,baseUrl:origin,contract:'mobile-top-up/8.2.0',allowedCategories:['Mobile Operators'],allowedOperatorIds:['6']} as const;
const approval={...account,origin,credentialReference:'fixture/catalogue',environment:'SANDBOX',provider:'SSL_WIRELESS',
  contract:ssl.contract,country:'BD',categories:ssl.allowedCategories,operators:ssl.allowedOperatorIds,
  method:'GET',path:'/api/vr/package-list',requestBudget:1} as const;

test('sandbox preflight denies substitutions before accessing provider credentials or transport',async()=>{
  const unexpected=async():Promise<never>=>assert.fail('Unauthorized dependency');
  const proposals=[
    {...approval,origin:'https://other.fixture.invalid'}, {...approval,providerAccountId:account.tenantId},
    {...approval,path:'/api/bill-payment'}, {...approval,credentialReference:''}, {...approval,operators:['1']},
    {...approval,categories:['Other Services']}, {...approval,subChannelId:'101'},
  ];
  for(const entry of proposals)assert.deepEqual(await qualifySslCatalogueRead('package-list',ssl,entry,unexpected,unexpected),
    {outcome:'SCOPE_DENIED',requests:0});
});

test('SSL sandbox scope caps upstream requests and returns only sanitized validation counts',async()=>{
  const ref='fixture/catalogue', secret='synthetic-catalogue';
  const resolve=async(reference:string, member:typeof account)=>{
    assert.equal(reference,ref);assert.deepEqual(member,account);
    return {stkCode:secret,authKey:secret};
  };
  const body={status:'success',data:{count:1,list:[{operator_id:6,operator_name:'Fixture Operator',amount:15.25,
    connection_type:'prepaid',offer_type:'voice',offer_title:secret}],triggerAmount:{}}};
  const response=await qualifySslCatalogueRead('package-list',ssl,approval,resolve,async(url,init)=>{
    assert.equal(url,origin+'/api/vr/package-list');assert.equal(init?.method,'GET');
    return Response.json(body);
  });
  assert.deepEqual(response,{outcome:'SCHEMA_ACCEPTED',records:1,requests:1});
  let sent=0;
  assert.deepEqual(await qualifySslCatalogueRead('package-list',ssl,approval,resolve,async()=>{
    sent++;return new Response('',{status:503});
  }),{outcome:'READ_FAILED',requests:1});
  assert.equal(sent,1);
});

test('IronGate sandbox admission pins the read POST and its account-specific success code',async()=>{
  const config={account,baseUrl:origin,successCodes:{games:'fixture-success'}};
  const grant={...account,origin,credentialReference:'fixture/irongate',environment:'SANDBOX',provider:'IRONGATE',
    contract:'irongate/prepaid-v2+postpaid/catalogue',method:'POST',path:'/api/gamelist',successCode:'fixture-success',requestBudget:1} as const;
  let resolved=0;
  const resolve=async()=>{resolved++;return {username:'synthetic-user',apiKey:'synthetic-key'};};
  const fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(input,origin+'/api/gamelist');assert.equal(init?.method,'POST');
    return Response.json({data:{rc:'fixture-success',gamelist:[{game_code:1,name:'Example'}]}});
  };
  for(const changed of [{...grant,path:'/api/top-up'},{...grant,successCode:'different'},{...grant,requestBudget:2 as const}])
    assert.deepEqual(await qualifyIronGateCatalogueRead('games',config,changed,resolve,fetch),{outcome:'SCOPE_DENIED',requests:0});
  assert.equal(resolved,0);
  assert.deepEqual(await qualifyIronGateCatalogueRead('games',config,grant,resolve,fetch),{outcome:'SCHEMA_ACCEPTED',records:1,requests:1});
});
