import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../../../../packages/galaxy-official/src/accounts/uid.mjs';
import {OfficialAccountData} from '../../../../packages/galaxy-official/src/accounts/data.mjs';
import {AccountWorkService} from '../../../../packages/galaxy-official/src/accounts/work.mjs';
import {CommunityAccountRegistry} from '../../../../packages/galaxy-official/src/accounts/community-accounts.mjs';
import {AccessService} from '../../../../packages/galaxy-official/src/security/access.mjs';
import {accountWorkPutSchema} from '../../../../packages/galaxy-official/src/shared/account-work-schema.mjs';
import {generateKeyPairSync,randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='archive-fixture.json')throw Error('disposable fixture required');
const db=new pg.Pool({connectionString:address.href}),endpoint='https://archive.example.invalid',issuer='https://login.example.invalid',now=()=>2000000000;
const access=new AccessService({db,endpoint,now}),registry=new CommunityAccountRegistry(access,[{describe:()=>({issuer,clientId:'archive-fixture'})}]),work=new AccountWorkService(access,{accounts:registry});
const accountData=new OfficialAccountData({db,endpoint,now}),digest=x=>createHash('sha256').update(x).digest('hex');
try{
 if(mode==='setup'){
  await migrate(db,{roles:['api']});
  const subjectId='GUID'+'0'.repeat(28),key=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}),challenge=randomUUID(),bindingId=randomUUID(),token=randomBytes(32).toString('base64url'),link=randomUUID();
  await db.query('INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,\'{}\')',[subjectId,key]);
  await db.query('INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',[challenge,subjectId,JSON.stringify({installationId:'archive-fixture'}),digest('challenge'),'2099-01-01']);
  await db.query('INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,\'controlled\',$4,\'["binding"]\',\'controlled\',\'2099-01-01\')',[bindingId,subjectId,challenge,endpoint]);
  await db.query('INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at) VALUES($1,$2,\'["binding"]\',\'2099-01-01\')',[digest(token),bindingId]);
  const account=await transaction(db,async tx=>{const a=await upsertOfficialAccountWithin(tx,{endpoint,issuer,externalSubject:'controlled-archive-account',verificationMethod:'email',verifiedAt:now()});await ensureOfficialAccountProfileWithin(tx,a.id,{subjectType:'person',now:now()});return a});
  await db.query('INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature) VALUES($1,$2,$3,$4,\'fixture\',$5,\'controlled-archive-account\',\'archive-fixture\',\'{}\',$6,\'controlled\')',[link,subjectId,bindingId,endpoint,issuer,digest('{}')]);
  await db.query('INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)',[link,account.id,subjectId,new Date(now()*1000)]);
  const actor={...await access.authenticate(token,'binding'),accountId:account.id},archiveActor={...actor,kind:'linked-id',accountAuthorized:true,endpoint};
  const put={operationId:randomUUID(),workId:'controlled/work',scopeId:randomUUID(),revision:1,expectedRevision:0,data:{workId:'controlled/work',galaxyId:subjectId,source:{host:'codex',sessionId:'isolated'},workType:'development',role:'owner',resultStatus:'unknown',resultSource:'host-observations',environments:[],uploadLevel:'history-overview'}};
  const jsReceipt=await work.put(actor,put),archive={id:randomUUID(),title:'Original selected copy',selection:{workspaceId:null,sessionIds:['isolated'],scopeId:randomUUID()},uploadLevel:'conversation-archive',includeFullConversation:true};
  await accountData.createArchive(archiveActor,archive);await accountData.appendChunk(archiveActor,{id:archive.id,sequence:0,content:'original JS chunk'});
  await writeFile(path,JSON.stringify({endpoint,issuer,accountId:account.id,token,link,put,archive,jsReceipt}),{mode:0o600});console.log('{}');
 }else{
  const f=JSON.parse(await readFile(path,'utf8')),actor={...await access.authenticate(f.token,'binding'),accountId:f.accountId},a={...actor,kind:'linked-id',accountAuthorized:true,endpoint};
  if(mode==='read')console.log(JSON.stringify({work:await work.get(actor,{workId:f.put.workId}),workList:await work.list(actor,{}),archive:await accountData.archiveStatus(a,{id:f.archive.id}),archives:await accountData.listArchives(a,{})}));
  else if(mode==='portal-read')console.log(JSON.stringify({archives:await accountData.listArchives({kind:'official-account',accountId:f.accountId,endpoint},{limit:1})}));
  else if(mode==='validate'){let raw='';for await(const chunk of process.stdin)raw+=chunk;const tests=JSON.parse(raw);console.log(JSON.stringify({checks:tests.map(x=>accountWorkPutSchema.safeParse(x).success)}));}
  else throw Error('mode required');
 }
}finally{await db.end();}
