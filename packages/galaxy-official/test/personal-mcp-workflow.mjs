import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { createServer,request as httpRequest } from 'node:http';
import { Client,StreamableHTTPClientTransport,auth,LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from "../src/identity/authentication/oidc-login.mjs";
import { createOAuthIntrospection } from "../src/identity/authentication/oauth-introspection.mjs";
import { createOAuthResourceAccess } from "../src/identity/authentication/oauth-resource-access.mjs";
import { IdentityLinkService } from "../src/identity/links.mjs";
import { createPersonalMcpHandler } from '../src/adapters/mcp/personal/handler.mjs';
import { createApi } from '../src/http.mjs';
import { handleDocsMcp } from "../src/adapters/mcp/personal/docs-mcp.mjs";
import { httpFailureWriter } from '../src/infrastructure/http-failure-audit.mjs';
import { AccessService } from "../src/security/access.mjs";

export async function verifyPersonalMcp(database=null,options={}) {
  const endpoint='https://official.example.org',resource=endpoint+'/mcp/personal',otherResource=endpoint+'/different-resource';
  const clientRedirect='http://127.0.0.1:44889/callback',resourceSecret=randomBytes(32).toString('base64url');
  const scopes=['binding','consent','case-teaser','history','proof','audit','data-export','notifications','assistance','context','capsules','builders','evidence'];
  const oauthScopes=scopes.map(value=>'galaxy:'+value);
  const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture',clientRedirect],{
    introspectionClientId:'galaxy-resource-fixture',resources:[resource,otherResource].map(resource=>({resource,scope:oauthScopes.join(' ')})),
    extraClients:[{client_id:'galaxy-mcp-fixture',redirect_uris:[clientRedirect],response_types:['code'],grant_types:['authorization_code'],token_endpoint_auth_method:'none'},
      {client_id:'galaxy-resource-fixture',client_secret:resourceSecret,redirect_uris:[],response_types:[],grant_types:[],token_endpoint_auth_method:'client_secret_basic'}],
  });
  let f,api,proxy;const clients=[];
  try {
    const now=Math.floor(Date.now()/1000);
    f=await serviceFixture(scopes,database,{...options,now});
    const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',
      redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true});
    const identity=new IdentityLinkService(f.access,[provider]);
    const login=await identity.begin(f.actor,{providerId:'fixture'}),returned=await issuer.authorize(login.authorizationUrl);
    await identity.callback('fixture',returned);
    const pending=await identity.status(f.actor,{id:login.loginId});
    await identity.confirm(f.actor,{id:login.loginId,signed:await f.signForTest(pending.payloadJson,'galaxy-identity-link+jws')});
    let unavailable=false;
    const verifier=await createOAuthIntrospection({issuer:issuer.issuer,resource,clientId:'galaxy-resource-fixture',clientSecret:resourceSecret,
      allowedClientIds:['galaxy-mcp-fixture'],allowLoopbackHttp:true,fetch:(input,options)=>{
        if(unavailable)throw new Error('Synthetic authorization-server outage');return fetch(input,options);
      }});
    const authority=createOAuthResourceAccess(f.access,{provider:provider.describe(),verifier,allowedScopes:scopes});
    const personalMcp=createPersonalMcpHandler({services:f,authority,verifier,allowLoopbackHttp:true});
    const failures=[];
    const writeFailure=httpFailureWriter(f.db,endpoint);
    api=createApi({...f,identity,personalMcp,docsMcp:handleDocsMcp,rateLimit:300,failureAudit:async event=>{failures.push(event);return writeFailure(event);}});
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const apiOrigin=`http://127.0.0.1:${api.address().port}`,requests=[];
    proxy=createServer((request,response)=>{
      const upstream=httpRequest(apiOrigin+request.url,{method:request.method,headers:{...request.headers,host:new URL(endpoint).host}},reply=>{
        response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);
      });
      upstream.on('error',()=>{response.statusCode=502;response.end();});request.pipe(upstream);
    });
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${proxy.address().port}`;
    const fetchFn=async(input,options)=>{
      const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
      if(url.pathname==='/token'&&typeof options?.body?.toString==='function'){
        const params=new URLSearchParams(options.body.toString());requests.push({kind:'token',resource:params.get('resource'),pkce:!!params.get('code_verifier')});
      }
      if(url.origin!==endpoint)return fetch(input,options);
      const headers=new Headers(options?.headers);headers.set('host',new URL(endpoint).host);
      return fetch(origin+url.pathname+url.search,{...options,headers});
    };
    const rpc=async(token,message={jsonrpc:'2.0',id:randomUUID(),method:'tools/list'},path='/mcp/personal')=>{
      const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',
        host:new URL(endpoint).host,'mcp-protocol-version':LATEST_PROTOCOL_VERSION,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(message)});
      const text=await response.text();return {status:response.status,headers:response.headers,value:text?JSON.parse(text):null};
    };
    const missing=await rpc();assert.equal(missing.status,401);assert.ok(missing.headers.get('www-authenticate').includes('resource_metadata="'+endpoint+personalMcp.metadataPath+'"'));
    assert.ok(missing.headers.get('www-authenticate').includes('galaxy:binding'));
    const metadata=await (await fetch(origin+personalMcp.metadataPath)).json();
    assert.equal(metadata.resource,resource);assert.deepEqual(metadata.authorization_servers,[issuer.issuer]);assert.deepEqual(metadata.scopes_supported,['galaxy:binding']);

    async function authorize(scope,target=resource) {
      let tokens,verifier,authorization,discovery;
      const state=randomUUID();
      const client={redirectUrl:clientRedirect,clientMetadata:{redirect_uris:[clientRedirect],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'},
        clientInformation:()=>({client_id:'galaxy-mcp-fixture'}),tokens:()=>tokens,saveTokens:value=>{tokens=value;},
        saveCodeVerifier:value=>{verifier=value;},codeVerifier:()=>verifier,state:()=>state,redirectToAuthorization:url=>{authorization=url;},
        saveDiscoveryState:value=>{discovery=value;},discoveryState:()=>discovery};
      const options={serverUrl:target,scope,fetchFn:target===resource?fetchFn:async(input,options)=>{
        if(String(input)===endpoint+personalMcp.metadataPath)return Response.json({...metadata,resource:target});
        return fetchFn(input,options);
      },resourceMetadataUrl:new URL(endpoint+personalMcp.metadataPath)};
      assert.equal(await auth(client,options),'REDIRECT');
      assert.equal(authorization.searchParams.get('resource'),target);assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
      const callback=await issuer.authorize(authorization.href);assert.equal(callback.searchParams.get('state'),state);
      const exchanged=requests.filter(item=>item.kind==='token').length;
      await assert.rejects(auth(client,{...options,authorizationCode:callback.searchParams.get('code'),iss:'https://wrong-issuer.example'}));
      assert.equal(requests.filter(item=>item.kind==='token').length,exchanged,'issuer mix-up must fail before code exchange');
      assert.equal(await auth(client,{...options,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss')}),'AUTHORIZED');
      return tokens.access_token;
    }
    const token=await authorize(oauthScopes.join(' '));
    assert.ok(requests.some(item=>item.kind==='token'&&item.resource===resource&&item.pkce));
    const sdk=new Client({name:'independent-personal-client',version:'1.0'});
    clients.push(sdk);
    await sdk.connect(new StreamableHTTPClientTransport(new URL(resource),{fetch:fetchFn,requestInit:{headers:{authorization:'Bearer '+token}}}));
    const tools=await sdk.listTools();
    for(const name of ['galaxy_case_submit','galaxy_tasks_v2_query','galaxy_task_v2_create','galaxy_participation_v2_event','galaxy_account_quotas',
      'galaxy_trust_sources','galaxy_trust_permission_preview','galaxy_trust_permission_revoke_preview',
      'galaxy_trust_permission_submit','galaxy_trust_permission_receipt','galaxy_trust_permission_status','galaxy_trust_permission_query',
      'galaxy_personal_summary_receipt'])
      assert.ok(tools.tools.some(tool=>tool.name===name),'required current or compatible tool: '+name);
    const summaryReceiptInput={summaryId:randomUUID(),versionId:randomUUID()};
    const summaryReceipt=await sdk.callTool({name:'galaxy_personal_summary_receipt',arguments:summaryReceiptInput});
    assert.ok(!summaryReceipt.isError,JSON.stringify(summaryReceipt));
    assert.deepEqual(JSON.parse(summaryReceipt.content[0].text),{state:'absent',operationVersionId:summaryReceiptInput.versionId,summaryId:summaryReceiptInput.summaryId,readOnly:true});
    const emptyTrust=await sdk.callTool({name:'galaxy_trust_permission_query',arguments:{}});
    assert.ok(!emptyTrust.isError,JSON.stringify(emptyTrust));
    const forgedTrust=await sdk.callTool({name:'galaxy_trust_permission_submit',arguments:{signed:'unsigned-model-approval'}});
    assert.equal(forgedTrust.isError,true,'transport OAuth cannot supply a current-device trust reproduction signature');
    const status=JSON.parse((await sdk.callTool({name:'galaxy_connection_status',arguments:{}})).content[0].text);
    assert.equal(status.subjectId,f.actor.subjectId);assert.equal(status.authorization,'oauth-resource');
    const proactive={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',
      workContext:{goal:'Review a working parser',currentSituation:'No observed failure',attemptRefs:[]},
      title:'Review parser behavior',summary:'Synthetic private Task via independent MCP SDK',visibility:'Private',
      collaboration:'open-assistance',enrollmentExpiresAt:now+3600};
    const taskGrant=await f.authorize(proactive,'assistance.publish',{objectId:proactive.operationId});
    const taskCreated=await sdk.callTool({name:'galaxy_task_v2_create',arguments:taskGrant});
    assert.ok(!taskCreated.isError,JSON.stringify(taskCreated));
    const taskRead=await sdk.callTool({name:'galaxy_task_v2_get',arguments:{taskId:proactive.taskId}});
    assert.ok(!taskRead.isError,JSON.stringify(taskRead));
    assert.equal(JSON.parse(taskRead.content[0].text).caseId,null);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,0);
    for(const name of ['galaxy_consents_query','galaxy_history_query','galaxy_assistance_query','galaxy_notifications_query','galaxy_capsules_query','galaxy_builders_query','galaxy_audit_query']) {
      const result=await sdk.callTool({name,arguments:{}});assert.ok(!result.isError,name+': '+JSON.stringify(result));
    }
    const discoveryProject = { id: randomUUID(), kind: 'module', title: 'Synthetic MCP search', summary: 'Explicit module description', functions: ['全文搜索'], technologies: ['JavaScript'], discoverable: true };
    const declaration = { id: randomUUID(), expectedRevision: 0, selfDeclared: { projects: [discoveryProject] } };
    const profileSubmission = await f.authorize(declaration, 'profile.publish');
    for (const [name, input] of [
      ['galaxy_profile_submit', profileSubmission],
      ['galaxy_discovery_preferences', {}],
      ['galaxy_discovery_preferences_save', { expectedRevision: 0, preferences: { enabled: true } }],
      ['galaxy_discovery_query', { projectId: discoveryProject.id }],
    ]) {
      const result = await sdk.callTool({ name, arguments: input }); assert.ok(!result.isError, JSON.stringify({ name, result }));
      if (name === 'galaxy_discovery_query') assert.equal(JSON.parse(result.content[0].text).enabled, true);
    }
    const parent={kind:'case',id:randomUUID(),localRef:'case-oauth',title:'OAuth Case workflow',summary:'Synthetic authorized MCP workflow',
      source:{kind:'local',reference:'case-oauth'},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const submission=await f.authorize(parent);
    const submitted=await sdk.callTool({name:'galaxy_case_submit',arguments:submission});assert.ok(!submitted.isError,JSON.stringify(submitted));
    const read=await sdk.callTool({name:'galaxy_case_get',arguments:{id:parent.id}});assert.ok(!read.isError);
    const search=await sdk.callTool({name:'galaxy_search_query',arguments:{type:'case',query:{}}});assert.ok(!search.isError);
    const exportId=randomUUID();
    for(const [name,input] of [['galaxy_export_create',{id:exportId,datasets:['cases']}],['galaxy_export_page',{id:exportId,dataset:'cases'}],['galaxy_export_revoke',{id:exportId}]]) {
      const result=await sdk.callTool({name,arguments:input});assert.ok(!result.isError,JSON.stringify({name,result}));
    }
    const denied=await sdk.callTool({name:'galaxy_case_submit',arguments:{...submission,payloadJson:JSON.stringify({...parent,title:'not the signed payload'})}});
    assert.equal(denied.isError,true,'OAuth scopes cannot replace the exact Galaxy Consent');
    const shallow=await authorize('galaxy:binding');
    const scopeFailure=await rpc(shallow,{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'galaxy_case_get',arguments:{id:parent.id}}});
    assert.equal(scopeFailure.status,403);assert.ok(scopeFailure.headers.get('www-authenticate').includes('galaxy:case-teaser'));
    const trustScopeFailure=await rpc(shallow,{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'galaxy_trust_permission_query',arguments:{}}});
    assert.equal(trustScopeFailure.status,403);
    assert.ok(trustScopeFailure.headers.get('www-authenticate').includes('galaxy:consent'),'trust reproduction uses its separate current Consent scope');
    const {actor:shallowActor}=await authority.authenticate(shallow);
    await assert.rejects(f.cases.get(shallowActor,parent.id),error=>error.code==='access_denied');
    const {actor:fullActor,authInfo:fullInfo}=await authority.authenticate(token);
    const restartedAccess=new AccessService(f.access),restartedAuthority=createOAuthResourceAccess(restartedAccess,{provider:provider.describe(),verifier,allowedScopes:['binding']});
    const {actor:restartedActor}=await restartedAuthority.authenticate(token);
    assert.deepEqual(restartedActor.scopes,['binding'],'configured resource scopes further restrict an otherwise broad token');
    assert.equal(await restartedAccess.runAuthorized(restartedActor,'binding',async()=>true),true,'committed association survives resource adapter restart');
    await assert.rejects(f.cases.get({...fullActor},parent.id),error=>error.code==='access_denied','public actor fields do not mint authority');
    const savedClock=f.access.now;f.access.now=()=>fullInfo.expiresAt;
    await assert.rejects(f.cases.get(fullActor,parent.id),error=>error.code==='access_denied');f.access.now=savedClock;
    assert.ok(failures.some(event=>event.actor?.authentication?.version===2&&event.actor.authentication.clientId==='galaxy-mcp-fixture'));
    assert.equal((await rpc(f.credential)).status,401,'legacy Galaxy bearer is not an OAuth token');
    const wrongAudience=await authorize(oauthScopes.join(' '),otherResource);assert.equal((await rpc(wrongAudience)).status,401);
    issuer.setAccount('unlinked-synthetic-subject');const unlinked=await authorize('galaxy:binding');assert.equal((await rpc(unlinked)).status,401);
    const other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false,now});
    const otherIdentity=new IdentityLinkService(other.access,[provider]);
    const otherLogin=await otherIdentity.begin(other.actor,{providerId:'fixture'});
    await otherIdentity.callback('fixture',await issuer.authorize(otherLogin.authorizationUrl));
    const otherPending=await otherIdentity.status(other.actor,{id:otherLogin.loginId});
    await otherIdentity.confirm(other.actor,{id:otherLogin.loginId,signed:await other.signForTest(otherPending.payloadJson,'galaxy-identity-link+jws')});
    const otherToken=await authorize(oauthScopes.join(' '));
    const foreign=await rpc(otherToken,{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'galaxy_case_get',arguments:{id:parent.id}}});
    assert.equal(foreign.value.result.isError,true);assert.ok(!JSON.stringify(foreign.value).includes(parent.summary),'linked users cannot read another private Case');
    issuer.setAccount('synthetic-oidc-subject');
    assert.equal((await fetch(apiOrigin+'/mcp/personal')).status,403,'exact Host check');
    assert.equal((await fetch(origin+'/mcp/personal',{headers:{origin:'https://foreign.example'}})).status,403,'browser origin remains closed');
    assert.equal((await fetch(origin+'/mcp/personal?access_token=synthetic')).status,400,'credentials in query are rejected');
    unavailable=true;assert.equal((await rpc(token)).status,503,'an AS outage cannot continue with cached token claims');unavailable=false;
    await issuer.revokeToken(shallow);assert.equal((await rpc(shallow)).status,401,'AS token revocation is read on every request');
    await identity.revoke(f.actor,{id:login.loginId});assert.equal((await rpc(token)).status,401,'local account unlink rejects an otherwise valid AS token');
    await assert.rejects(f.cases.get(fullActor,parent.id),error=>error.code==='access_denied','an earlier actor cannot outlive unlink');
    const relogin=await identity.begin(f.actor,{providerId:'fixture'});await identity.callback('fixture',await issuer.authorize(relogin.authorizationUrl));
    const relink=await identity.status(f.actor,{id:relogin.loginId});await identity.confirm(f.actor,{id:relogin.loginId,signed:await f.signForTest(relink.payloadJson,'galaxy-identity-link+jws')});
    assert.equal((await rpc(token)).status,200);
    await f.bindings.revoke(f.actor.bindingId,f.actor.subjectId,randomUUID(),null,f.actor);
    assert.equal((await rpc(token)).status,401,'original binding revocation rejects a linked token');
    assert.equal((await rpc(null,{jsonrpc:'2.0',id:1,method:'tools/list'},'/mcp/docs')).status,200,'Docs MCP remains anonymous');
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE action='oauth.access' ORDER BY sequence")).rows;
    assert.ok(audit.length>=3);assert.ok(audit.every(row=>row.client_id==='galaxy-mcp-fixture'&&row.audience===resource&&row.context_version===1));
    assert.ok(!JSON.stringify(audit).includes(token));assert.ok(!JSON.stringify(failures).includes(token));
    const storedFailure=(await f.db.query("SELECT * FROM audit_events WHERE action='http.rejected' AND caller_client_id='galaxy-mcp-fixture'")).rows;
    assert.ok(storedFailure.some(row=>row.outcome==='403'&&row.caller_audience===resource&&row.object_id==='POST /mcp/personal'));
    return {schema:41,tools:tools.tools.length,mcpProtocol:LATEST_PROTOCOL_VERSION,independentMcpClient:true,actualOAuthCodePkce:true,resourceParameter:true,
      standard401and403:true,exactConsent:true,introspectionRevocation:true,localUnlink:true,bindingRevocation:true,wrongAudience:true,
      unlinkedSubject:true,crossUser:true,issuerMixup:true,asOutage503:true,scopeIntersection:true,actorExpiry:true,actorForgeryRejected:true,
      resourceRestart:true,durableFailureAudit:true,oauthAudit:true,anonymousDocsPreserved:true};
  } finally {
    for(const client of clients)await client.close();
    if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
    if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
    if(f&&!database)await f.db.close();await issuer.close();
  }
}
