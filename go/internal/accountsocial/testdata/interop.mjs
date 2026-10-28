import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {communityForumFixture} from '../../../../packages/galaxy-official/test/community-forum-fixture.mjs';
import {AccountFollowsV1} from '../../../../packages/galaxy-official/src/accounts/follows-v1.mjs';
import {ReadingBookmarksV1} from '../../../../packages/galaxy-official/src/accounts/reading-bookmarks-v1.mjs';
import {CommunityAccountRegistry} from '../../../../packages/galaxy-official/src/accounts/community-accounts.mjs';
import {CommunityForumV1} from '../../../../packages/galaxy-official/src/community/community-forum-v1.mjs';
import {AccessService} from '../../../../packages/galaxy-official/src/security/access.mjs';
import {OfficialAccountData} from '../../../../packages/galaxy-official/src/accounts/data.mjs';
import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../../../../packages/galaxy-official/src/accounts/uid.mjs';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {accountFollowCommandSchema} from '../../../../packages/galaxy-official/src/shared/account-follows-schema.mjs';
import {readingBookmarkCommandSchema} from '../../../../packages/galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs';
import {digest} from '../../../../packages/galaxy-official/src/shared/digest.mjs';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||basename(path)!=='social-fixture.json')throw Error('disposable fixture file required');
const db=new pg.Pool({connectionString:address.href,max:8});
try{
 if(mode==='hashes'){let raw='';for await(const b of process.stdin)raw+=b;const items=JSON.parse(raw);console.log(JSON.stringify({checks:items.map(x=>{const p=(x.follow?accountFollowCommandSchema:readingBookmarkCommandSchema).safeParse(x.value);return p.success?{accepted:true,hash:digest(JSON.stringify(p.data))}:{accepted:false}})}))}
 else if(mode==='setup'){
  const f=await communityForumFixture({database:db});
  try{
   await migrate(db,{roles:['api']});await f.login(f.owner,'social-owner');await f.login(f.responder,'social-target');
   const owner=(await f.owner.communityAccounts.availableWithin(db,f.owner.actor))[0].id,target=(await f.owner.communityAccounts.availableWithin(db,f.responder.actor))[0].id,endpoint=f.owner.access.endpoint,now=f.clock.now,issuer=f.issuer.issuer;
   const profiles=new OfficialAccountData({db,endpoint,now:()=>now}),targets=[target];
   for(let i=0;i<2;i++)targets.push((await transaction(db,async tx=>{const a=await upsertOfficialAccountWithin(tx,{endpoint,issuer,externalSubject:'isolated-follow-target-'+i,verificationMethod:'external-account',verifiedAt:now});await ensureOfficialAccountProfileWithin(tx,a.id,{now});return a})).id);
   for(const id of targets)await profiles.updateSettings({kind:'official-account',endpoint,accountId:id},{expectedRevision:0,displayName:null,publicQuery:{enabled:true,scope:'profile'},archiveRetentionDays:null});
   const posts=[];for(let i=0;i<3;i++){const p=await f.post({title:'Isolated bookmark source '+i,body:'Source body stays in the original signed forum ledger '+i});const result=await f.write(f.owner,'create-post',p);if(result.status!==200)throw Error('original source publication failed');posts.push({kind:'forum-post',postId:p.postId})}
   const actor={kind:'official-account',endpoint,accountId:owner},follows=new AccountFollowsV1({accounts:f.owner.communityAccounts,endpoint,now:()=>now}),bookmarks=new ReadingBookmarksV1(f.owner.access,{forum:f.forum,accounts:f.owner.communityAccounts});
   const follow={operationId:randomUUID(),targetAccountId:target,following:true,expectedRevision:0},save={operationId:randomUUID(),reference:posts[0],saved:true,expectedRevision:0},personal={...save,operationId:randomUUID()};
   const followReceipt=await follows.command(actor,follow),saveReceipt=await bookmarks.accountCommand(actor,save),personalReceipt=await bookmarks.command(f.owner.actor,personal);
   const linkedSave={operationId:randomUUID(),reference:posts[1],saved:true,expectedRevision:0};await bookmarks.accountCommand({...f.owner.actor,accountId:owner},linkedSave);
   await writeFile(path,JSON.stringify({endpoint,now,issuer,owner,target,targets,posts,token:f.owner.credential,subject:f.owner.actor.subjectId,follow,save,personal,linkedSave,followReceipt,saveReceipt,personalReceipt}),{mode:0o600});console.log('{}');
  }finally{await f.close()}
 }else{
  const f=JSON.parse(await readFile(path,'utf8')),access=new AccessService({db,endpoint:f.endpoint,now:()=>f.now}),accounts=new CommunityAccountRegistry(access,[{describe:()=>({issuer:f.issuer,clientId:'galaxy-fixture'})}]),forum=new CommunityForumV1(access,null,{accounts}),follows=new AccountFollowsV1({accounts,endpoint:f.endpoint,now:()=>f.now}),bookmarks=new ReadingBookmarksV1(access,{forum,accounts}),actor={kind:'official-account',endpoint:f.endpoint,accountId:f.owner};
  if(mode==='read')console.log(JSON.stringify({follows:await follows.query(actor,{}),bookmarks:await bookmarks.accountQuery(actor,{}),personal:await bookmarks.query(await access.authenticate(f.token,'binding'),{})}));
  else throw Error('mode required');
 }
}finally{await db.end()}
