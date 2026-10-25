import {forumBodyExcerpt} from '../shared/community-forum-body-text.mjs';
import {transaction} from '../database.mjs';
import {ServiceError} from '../shared/service-error.mjs';
import {discoveryItemKey} from './purpose.mjs';
import {digest} from '../shared/digest.mjs';
import {CommunityForumV1} from '../community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../community-forum-governance-v1.mjs';
import {CommunityAccountRegistry} from '../community-accounts.mjs';
import {ConsentReader} from '../consent-reader.mjs';
import {publicReadBatch} from './public-read-batch.mjs';

// This adapter deliberately has no message, notice, case, bookmark, generic
// search-document or privileged operations reader. Public eligibility comes
// from the original anonymous forum reader, including current grants/sections
// and all effective governance overlays. Index candidates never grant access.
export class PublicCommunitySource{
 constructor({db,forum,endpoint,readOnly=false}){
  Object.assign(this,{db,forum,endpoint});
  if(readOnly){
   // The exact anonymous source checks are unchanged. A worker reader does
   // not acquire write-privilege-requiring row locks or receive UPDATE grants
   // to authorization records merely to qualify public indexing candidates.
   this.forum=Object.create(forum);this.forum.permissions=Object.create(forum.permissions);
   // Index qualification needs the stable author account ID, not public
   // display metadata; keep worker profile-column privileges unchanged.
   this.forum.authorWithin=(db,row)=>forum.authorWithin.call(this.forum,db,row,{includeDisplay:false});
   this.forum.accessRules=Object.create(forum.accessRules);this.forum.accessRules.forum=this.forum;
   this.forum.permissions.contentAudience=this.forum.accessRules.contentWithin.bind(this.forum.accessRules);
   this.forum.permissions.statusWithin=(db,id,options)=>forum.permissions.statusWithin.call(this.forum.permissions,db,id,{...options,lock:false});
   if(forum.governance){this.forum.governance=Object.create(forum.governance);this.forum.governance.forum=this.forum;this.forum.governance.permissions=this.forum.permissions;}
  }
 }
 async load(reference,{db=null}={}){if(!db)return transaction(this.db,db=>this.load(reference,{db}));const{kind,id}=reference;discoveryItemKey(kind,id);let view;
  try{view=kind==='post'?await this.forum.headWithin(db,id,{actor:null}):await this.forum.readReplyWithin(db,id,{actor:null});}catch(error){if(error instanceof ServiceError&&[401,403,404,409,410,422].includes(error.status))return null;throw error;}
  if(view.availability!=='available'||kind==='reply'&&view.parentAvailability!=='available')return null;
  if(view.authorAccountId&&!(await db.query('SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2',[view.authorAccountId,this.endpoint])).rows.length)return null;
  const payload=view.payload,version=kind==='post'?view.currentVersionId:String(view.revision);
  const document={id:discoveryItemKey(kind,id),kind,sourceId:id,version,postId:kind==='post'?id:view.locator.postId,authorAccountId:view.authorAccountId??null,title:kind==='post'?payload.title:'',body:payload.body,topic:view.topic??'unclassified',tags:(view.operatorCuration?.tags??[]).map(item=>typeof item==='string'?item:item.name).filter(item=>typeof item==='string'),publishedAt:view.createdAt,publishedUntil:view.publishedUntil};
  return {...document,tagIds:view.operatorCuration?.tagIds??(view.operatorCuration?.tags??[]).filter(item=>item&&typeof item==='object'&&typeof item.id==='string').map(item=>item.id),indexVersion:digest(JSON.stringify({version,title:document.title,body:document.body,topic:document.topic,tags:document.tags,publishedUntil:document.publishedUntil}))};
 }
 // A complete metadata scan uses the same anonymous reader in a stable DB
 // snapshot. At most 100 source readers and 32 identical SELECT calls run in
 // each bounded wave; no page, policy or authority survives this transaction.
 async qualifiedSnapshot(){return transaction(this.db,async db=>{
  const startedAt=this.forum.clock(),reader=new PublicCommunitySource({db,forum:this.forum,endpoint:this.endpoint,readOnly:true}),documents=[];
  let after='',scanned=0;
  for(;;){const rows=await reader.candidates({after,limit:100,db});if(!rows.length)break;
   // Reuse only identical fixed reads within this wave and this transaction;
   // a fresh map at the next wave keeps the original clock/eligibility checks.
   const batch=publicReadBatch(db,{reuseKnownBindings:true});
   const current=await Promise.all(rows.map(reference=>reader.load(reference,{db:batch})));
   for(const document of current)if(document)documents.push(document);
   scanned+=rows.length;after=rows.at(-1).kind+':'+rows.at(-1).id;if(rows.length<100)break;
  }
  return {documents,complete:true,scanned,startedAt,completedAt:this.forum.clock()};
 },{isolation:'repeatable read'});}
 async candidates({after='',limit=100,db=this.db}={}){if(!Number.isInteger(limit)||limit<1||limit>200||after&&!/^(post|reply):[0-9a-f-]{36}$/.test(after))throw new ServiceError('invalid_discovery_request',400);const[kind,source]=after?after.split(':'):['',''];return (await db.query(`SELECT kind,id FROM (SELECT 'post' AS kind,id FROM forum_posts_v1 UNION ALL SELECT 'reply',id FROM forum_replies_v1) s WHERE kind>$1 OR kind=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY kind,id LIMIT $3`,[kind,source||null,limit])).rows;}
 view(document){return {kind:document.kind,id:document.sourceId,postId:document.postId,version:document.version,title:document.title,excerpt:Array.from(forumBodyExcerpt(document.body)).slice(0,220).join(''),topic:document.topic,publishedUntil:document.publishedUntil,href:'/app/community/'+(document.kind==='reply'?'replies/':'posts/')+encodeURIComponent(document.sourceId),source:'current-public-community'};}
}

// Worker construction uses the original read classes with a narrow access
// object. No AccessService, signing key, sessions, write budget or API service
// graph is constructed. The configured provider/moderator metadata must match
// the API so legacy evidence independence is evaluated identically.
export function createDiscoveryReadOnlySource({db,endpoint,now,readGrant,forumPolicy,moderatorIds=[],identityProviders=[]}){
 const access=Object.freeze({db,endpoint,now}),consents=new ConsentReader({now,readGrant});
 const providers=identityProviders.map(provider=>typeof provider.describe==='function'?provider:{describe:()=>provider});
 const accounts=new CommunityAccountRegistry(access,providers),forum=new CommunityForumV1(access,consents,{accounts,policy:forumPolicy});
 new CommunityForumGovernanceV1(access,consents,forum,{accounts,moderatorIds});
 return new PublicCommunitySource({db,endpoint,forum,readOnly:true});
}
