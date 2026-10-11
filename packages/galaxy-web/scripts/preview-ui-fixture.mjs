// Isolated synthetic UI fixture. No production identity, account or data is read.
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {oidcProviderFixture} from '../../galaxy-official/test/oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../../galaxy-official/src/oidc-login.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {randomUUID} from 'node:crypto';
import {ModerationNotificationAdapter} from '../../galaxy-official/src/moderation-notifications.mjs';
import {sourceCapsule} from '../../galaxy-official/test/capsule-origin-continuity-v2-workflow.mjs';
const origin='http://127.0.0.1:5190',now=Math.floor(Date.now()/1000),endpoint='https://official.example.org';
const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
const fixture=await serviceFixture(browserScopes,null,{now,identityProviders:[provider],syntheticCommunityQuota:false});
fixture.inbox.moderationNotifications=new ModerationNotificationAdapter(fixture.moderation);
let capsuleSeed=null;
const moderationSeeds=new Map();
async function moderationSeed(subjectId){if(!/^GUID[0-9A-Z]{28}$/.test(subjectId))throw Error('invalid synthetic subject');
 const reporter=await serviceFixture(browserScopes,fixture.db,{now,migrateDatabase:false}),moderator=await serviceFixture(browserScopes,fixture.db,{now,migrateDatabase:false});fixture.moderation.moderatorIds=[moderator.actor.subjectId];
 const source={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'合成复核来源',summary:'用于隔离验收的限定工作事实',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:fixture.actor.subjectId,role:'requester'}]};
 const sourceGrant=await fixture.authorize(source,'case.teaser.publish',{viewers:[reporter.actor.subjectId,moderator.actor.subjectId,subjectId]});await fixture.cases.submit(fixture.actor,sourceGrant);
 const report={id:randomUUID(),caseId:source.id,caseVersion:1,targetEventId:source.id,category:'misrepresentation',summary:'合成举报：请限定核对这项来源描述。'};await fixture.moderation.report(reporter.actor,await reporter.authorize(report,'moderation.publish',{viewers:[moderator.actor.subjectId]}));
 const invite={id:randomUUID(),reportId:report.id,expectedVersion:1,kind:'invite-verifier',summary:'邀请本人决定是否参与限定复核。',verifierId:subjectId,target:{caseId:source.id,caseVersion:1,targetEventId:source.id},scope:'只核对所示来源描述，材料不足时明确保留意见。',expiresAt:now+600};
 await fixture.moderation.event(moderator.actor,report.id,await moderator.authorize(invite,'moderation.publish',{viewers:[fixture.actor.subjectId,reporter.actor.subjectId,subjectId]}));moderationSeeds.set(report.id,{sourceGrant,moderator,reporter,subjectId});return{reportId:report.id,caseId:source.id,invitationId:invite.id};
}
const messageBodies=new Map();fixture.chat.transport={available:true,project:async()=>{},send:async x=>{messageBodies.set(x.messageId,x.text);return{archiveId:x.messageId};},read:async({ids})=>ids.filter(id=>messageBodies.has(id)).map(id=>({archiveId:id,text:messageBodies.get(id)})),delete:async id=>{messageBodies.delete(id);}};
const api=createApi({...fixture,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(r=>api.listen(5191,'127.0.0.1',r));
const publicRoot=resolve(fileURLToPath(new URL('../../../../../official-site/dist/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.md':'text/plain; charset=utf-8','.js':'text/javascript'};
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,origin);
 if(url.pathname==='/__fixture/capsule/source'&&req.method==='POST'){const v=capsuleSeed??=await sourceCapsule(fixture);res.setHeader('content-type','application/json');res.end(JSON.stringify({capsuleId:v.capsuleId,versionId:v.id,authorId:fixture.actor.subjectId}));return;}
 if(url.pathname==='/__fixture/moderation/setup'&&req.method==='POST'){let raw='';for await(const part of req)raw+=part;if(raw.length>1024)throw Error('oversize');res.setHeader('content-type','application/json');res.end(JSON.stringify(await moderationSeed(JSON.parse(raw).subjectId)));return;}
 if(url.pathname==='/__fixture/moderation/resolve'&&req.method==='POST'){let raw='';for await(const part of req)raw+=part;const reportId=JSON.parse(raw).reportId,seed=moderationSeeds.get(reportId);if(!seed)throw Error('missing synthetic seed');const current=await fixture.moderation.get(seed.moderator.actor,reportId),payload={id:randomUUID(),reportId,expectedVersion:current.version,kind:'resolve',summary:'合成处理者形成限定处理结论，以允许当事人申诉。',verdict:'dismissed'};await fixture.moderation.event(seed.moderator.actor,reportId,await seed.moderator.authorize(payload,'moderation.publish',{viewers:[fixture.actor.subjectId,seed.reporter.actor.subjectId,seed.subjectId]}));res.setHeader('content-type','application/json');res.end(JSON.stringify({resolved:true}));return;}
 if(url.pathname==='/__fixture/moderation/revoke-source'&&req.method==='POST'){let raw='';for await(const part of req)raw+=part;const seed=moderationSeeds.get(JSON.parse(raw).reportId);if(!seed)throw Error('missing synthetic seed');await fixture.consents.revoke(fixture.actor,seed.sourceGrant.consentId);res.setHeader('content-type','application/json');res.end(JSON.stringify({revoked:true}));return;}
 if(url.pathname==='/__fixture/login'&&req.method==='POST'){let raw='';for await(const part of req)raw+=part;if(raw.length>16000)throw Error('oversize');const input=JSON.parse(raw);if(new URL(input.authorizationUrl).origin!==issuer.issuer)throw Error('wrong fixture issuer');const callback=await issuer.authorize(input.authorizationUrl);const result=await fetch('http://127.0.0.1:5191'+callback.pathname+callback.search);res.setHeader('content-type','application/json');res.end(JSON.stringify({state:(await result.json()).state}));return;}
 if(url.pathname==='/galaxy-web-config.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({version:1,endpoint:fixture.bindings.endpoint,operator:'Synthetic local UI fixture',signingKeys:[...fixture.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}));return;}
 if(url.pathname==='/__fixture'){res.setHeader('content-type','application/json');res.end(JSON.stringify({synthetic:true,now,api:'http://127.0.0.1:5191',endpoint:fixture.bindings.endpoint,accountVerificationTested:false,tasks:(await fixture.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n}));return;}
 if(url.pathname.startsWith('/app')||url.pathname.startsWith('/@')||url.pathname.startsWith('/node_modules/')||url.pathname.startsWith('/packages/')){const reply=await fetch('http://127.0.0.1:5179'+req.url);res.statusCode=reply.status;for(const [k,v]of reply.headers)if(!['content-encoding','transfer-encoding','content-length'].includes(k))res.setHeader(k,v);res.end(Buffer.from(await reply.arrayBuffer()));return;}
 let target=resolve(publicRoot,'.'+decodeURIComponent(url.pathname));if(!target.startsWith(publicRoot+sep)&&target!==publicRoot){res.writeHead(403).end();return;}if((await stat(target)).isDirectory())target=resolve(target,'index.html');res.setHeader('content-type',mime[extname(target)]??'application/octet-stream');res.end(await readFile(target));
 }catch(error){console.error(JSON.stringify({fixtureError:error.code??error.message}));res.writeHead(404,{'content-type':'text/plain; charset=utf-8'}).end('Local preview file not found');}});
await new Promise(r=>server.listen(5190,'127.0.0.1',r));console.log(JSON.stringify({synthetic:true,website:origin,api:'http://127.0.0.1:5191',publicRoot,accountVerificationTested:false}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();api.close();await fixture.db.close();await issuer.close();process.exit(0);});

