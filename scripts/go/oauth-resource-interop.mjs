process.stdin.setEncoding('utf8');
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {readFile} from 'node:fs/promises';import {join,isAbsolute} from 'node:path';import {createPrivateKey,randomUUID,randomBytes} from 'node:crypto';
import {CompactSign} from '../../packages/galaxy-official/node_modules/jose/dist/webapi/index.js';
import {BindingService} from '../../packages/galaxy-official/src/identity/bindings.mjs';
import {AccessService} from '../../packages/galaxy-official/src/security/access.mjs';
import {IdentityLinkService} from '../../packages/galaxy-official/src/identity/links.mjs';
import {createOAuthIntrospection} from '../../packages/galaxy-official/src/identity/authentication/oauth-introspection.mjs';
import {createOAuthResourceAccess} from '../../packages/galaxy-official/src/identity/authentication/oauth-resource-access.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
let raw='';for await(const c of process.stdin)raw+=c;const x=JSON.parse(raw||'{}'),mode=process.argv[2],now=()=>2000000000;
const verifier=()=>createOAuthIntrospection({issuer:x.issuer,resource:x.resource,clientId:'i.d-client',clientSecret:'isolated._- credential',allowedClientIds:['mcp-client'],allowLoopbackHttp:true,now});
if(mode==='verify'){try{console.log(JSON.stringify({claim:await(await verifier()).verify(x.token)}))}catch(e){console.log(JSON.stringify({error:e.code??e.error??'discovery'}))}}else{
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR;if(!isAbsolute(dir??''))throw Error('disposable directory required');const db=new pg.Pool({connectionString:u.href,max:3}),endpoint='https://device.example.invalid';
try{if(mode==='setup'){
 const state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8')),owner=createPrivateKey(state.ownerPrivate),hub=createPrivateKey(state.hubPrivate),trustedKeys=new Map([['fixture',{publicKeyPem:state.hubPublic,notBefore:now()-100,notAfter:now()+100000}]]),binding=new BindingService({db,endpoint,signingKey:hub,kid:'fixture',trustedKeys,now,allowedScopes:['binding','history']}),access=new AccessService({db,endpoint,now,trustedKeys,sign:binding.sign.bind(binding)}),sign=(payload,typ)=>new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(owner);
 const challenge=await binding.challengeV2({subjectId:state.genesis.id,genesisProof:state.genesis.genesisProof,installationId:state.installationId,scopes:['binding','history'],control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}}),bound=await binding.bind({challenge:challenge.challenge,clientSession:challenge.clientSession,signature:await sign(challenge.challenge,'galaxy-binding-response+jws')}),token=randomBytes(32).toString('base64url'),session=await access.challenge({bindingId:bound.bindingId,credentialHash:digest(token)});await access.activate({challenge:session.challenge,signature:await sign(session.challenge,'galaxy-session-response+jws')});const actor=await access.authenticate(token,'binding');
 const provider={describe:()=>({id:'original',issuer:x.issuer,clientId:'linked-client',redirectUri:endpoint+'/v1/identity/callback/original'}),begin:async()=>({authorizationUrl:x.issuer+'/authorize?state=original-state',expiresAt:now()+300}),complete:async()=>({issuer:x.issuer,externalSubject:'external',clientId:'linked-client',authentication:'oidc',verifiedAt:now(),expiresAt:now()+300}),cancel:()=>{}};
 const links=new IdentityLinkService(access,[provider]),preview=await links.begin(actor,{providerId:'original'});await links.callback('original',endpoint+'/v1/identity/callback/original?state=original-state');const pending=await links.status(actor,{id:preview.loginId});await links.confirm(actor,{id:preview.loginId,signed:await sign(pending.payloadJson,'galaxy-identity-link+jws')});console.log(JSON.stringify({subjectId:actor.subjectId,bindingId:actor.bindingId,linkId:preview.loginId,deviceId:state.deviceId,endpoint}));
 }else if(mode==='authenticate'){
 await db.query('SET ROLE galaxy_api');const access=new AccessService({db,endpoint,now}),auth=createOAuthResourceAccess(access,{verifier:await verifier(),provider:{id:'original',issuer:x.issuer,clientId:'linked-client'},allowedScopes:['binding','history']}),value=await auth.authenticate(x.token,{httpRequestId:'33333333-3333-4333-8333-333333333333'});await access.runAuthorized(value.actor,'history',async()=>null);console.log(JSON.stringify({actor:{subjectId:value.actor.subjectId,bindingId:value.actor.bindingId,scopes:value.actor.scopes,authentication:value.actor.authentication},authInfo:{clientId:value.authInfo.clientId,scopes:value.authInfo.scopes,expiresAt:value.authInfo.expiresAt,resource:value.authInfo.resource.href}}));
 }else throw Error('unknown mode');
}finally{await db.end()}

}
