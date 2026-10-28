// Data preparation for the existing full galaxy-api entry and an independent
// browser. No server, website, issuer, model or transport is started here.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import canonicalize from '../../packages/galaxy-official/node_modules/canonicalize/lib/canonicalize.js';
import {transaction} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../../packages/galaxy-official/src/accounts/uid.mjs';
import {issueKeyring} from '../../packages/galaxy-official/src/security/trust-keyring.mjs';
import {bindForumIds} from '../../packages/galaxy-official/src/shared/community-forum-ids-v1.mjs';

const target=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(target.protocol!=='postgres:'||target.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(target.pathname))throw Error('isolated database required');
const [configFile,outputFile]=process.argv.slice(2).map(v=>v&&resolve(v));
const temporary=file=>{const rel=relative(resolve(tmpdir()),file);return rel&&!rel.startsWith('..')&&!isAbsolute(rel)};
if(!configFile||!outputFile||!temporary(configFile)||!temporary(outputFile))throw Error('OS temporary config/descriptor paths required');
// configFile contains the existing access-fixture.mjs JSON result, unchanged.
const files=JSON.parse(await readFile(configFile,'utf8'));
const accountConfig=JSON.parse(await readFile(files.accountFile,'utf8'));
const operatorConfig=JSON.parse(await readFile(files.operationsFile,'utf8'));
const root=JSON.parse(await readFile(operatorConfig.rootOperatorFile,'utf8'));
for(const field of ['accountScope','operatorConfiguration'])if(!/^[a-f0-9]{64}$/.test(files[field]))throw Error('original portal scope required');
if(new URL(files.endpoint).protocol!=='https:'||!['api.example.invalid','api.galaxy.localhost'].includes(new URL(files.endpoint).hostname))throw Error('isolated endpoint required');
const db=new pg.Pool({connectionString:target.href,max:2}),now=Math.floor(Date.now()/1000),at=new Date(now*1000);
const hash=v=>createHash('sha256').update(v).digest('hex'),token=()=>randomBytes(32).toString('base64url');
try{
 const state=await transaction(db,async tx=>{
  const people=[];
  for(const name of ['网页联检甲','网页联检乙']){
   const subject='browser-'+randomUUID();
   const account=await upsertOfficialAccountWithin(tx,{endpoint:files.endpoint,issuer:accountConfig.issuer,externalSubject:subject,verificationMethod:'external-account',verifiedAt:now});
   await ensureOfficialAccountProfileWithin(tx,account.id,{subjectType:'person',now});
   await tx.query('UPDATE official_account_profiles_v1 SET display_name=$2 WHERE account_id=$1',[account.id,name]);
   const value=token(),csrf=token();
   await tx.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`,[files.accountScope,hash(value),hash('fixture-login:'+value),account.id,accountConfig.issuer,subject,csrf,now,now+3600]);
   await tx.query(`INSERT INTO chat_participants_v3(actor_ref,kind,account_id) VALUES($1,'official-account',$2) ON CONFLICT DO NOTHING`,['account:'+account.id,account.id]);
   people.push({accountId:account.id,subject,cookie:{name:'__Host-galaxy-account',value},csrf});
  }
  await tx.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'隔离网页处理员',$5,$5) ON CONFLICT DO NOTHING`,[root.operatorId,files.endpoint,root.issuer,root.externalSubject,at]);
  const operatorToken=token(),operatorCSRF=token();
  await tx.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,'隔离网页处理员','administrator',$7,$8)`,[files.endpoint,files.operatorConfiguration,hash(operatorToken),root.operatorId,root.issuer,root.externalSubject,operatorCSRF,new Date((now+3600)*1000)]);
  // Ordinary room metadata only. No message body/archive or delivery result is
  // fabricated; real send/history require the existing configured transport.
  const roomId=randomUUID(),operationId=randomUUID();
  const create={roomId,operationId,title:'隔离网页会话',kind:'ordinary',taskRefs:[],retentionDays:90};
  await tx.query(`INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,kind,task_refs,retention_days,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'ordinary','[]',90,$6,$6)`,[roomId,'account:'+people[0].accountId,operationId,hash(canonicalize(create)),create.title,at]);
  for(const person of people)await tx.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$2,$3)',[roomId,'account:'+person.accountId,at]);
  const payload=await bindForumIds('create-post','account:'+people[0].accountId,{schemaVersion:1,operationId:randomUUID(),accountId:people[0].accountId,postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,title:'隔离网页连续流程',body:'该帖子应通过真实 Go API 发布，再从官网与社区回读。',links:[],attachments:[],topic:'technology',publishedUntil:now+3600});
  return {version:1,endpoint:files.endpoint,websiteOrigin:accountConfig.websiteOrigin,adminOrigin:operatorConfig.adminOrigin,people,operator:{operatorId:root.operatorId,issuer:root.issuer,subject:root.externalSubject,cookie:{name:'__Host-galaxy-operator',value:operatorToken},csrf:operatorCSRF},forum:{payload,postId:payload.postId,versionId:payload.versionId,published:false},chat:{roomId,messageDeliverySeeded:false},expiresAt:now+3600};
 });
 const directory=dirname(outputFile),pair=generateKeyPairSync('ed25519'),kid='isolated-browser-api';
 // The unchanged API loader requires the active signer to remain valid for
 // at least 86400s (including its issued keyring envelope), not just this UI run.
 const pin={kid,publicKeyPem:pair.publicKey.export({format:'pem',type:'spki'}),notBefore:now-60,notAfter:now+172800,revoked:false};
 const serviceFiles={signingKeyFile:join(directory,'browser-signing.pem'),rootPinsFile:join(directory,'browser-root-pins.json'),keyringFile:join(directory,'browser-keyring.json'),trustDirectory:join(directory,'browser-trust'),signingKeyId:kid};
 await mkdir(serviceFiles.trustDirectory,{mode:0o700});
 for(const [file,value]of [[serviceFiles.signingKeyFile,pair.privateKey.export({format:'pem',type:'pkcs8'})],[serviceFiles.rootPinsFile,JSON.stringify({version:1,endpoint:files.endpoint,sequence:1,keys:[pin]})],[serviceFiles.keyringFile,JSON.stringify(await issueKeyring({endpoint:files.endpoint,keys:[pin],sequence:1,rootKid:kid,rootPrivateKey:pair.privateKey,now}))]])await writeFile(file,value,{mode:0o600,flag:'wx'});
 const publicConfigurationFile=join(directory,'browser-web-config.json');
 await writeFile(publicConfigurationFile,JSON.stringify({version:1,endpoint:files.endpoint,signingKeys:[pin],operator:'隔离 Go API'}),{mode:0o600,flag:'wx'});
 state.serviceFiles=serviceFiles;state.publicConfigurationFile=publicConfigurationFile;
 // The descriptor contains random disposable test sessions. Never print them or
 // place this file in the repository; root's browser runner reads it directly.
 await writeFile(outputFile,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({descriptor:outputFile,dataPrepared:true,forumPublicationRequired:true,currentDirectoryStillRequired:true,chatTransportStillRequired:true}));
}finally{await db.end();}




