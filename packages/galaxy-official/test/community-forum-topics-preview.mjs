import {createServer} from 'node:https';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReconstructionFlowPreview} from './reconstruction-flow-preview.mjs';
import {defaultForumPolicy} from '../src/community-forum-policy-v1.mjs';
import {forumTopics} from '../src/shared/community-forum-topics-v1.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {digest} from '../src/shared/digest.mjs';

// Synthetic sample volume is explicit service configuration, not SQL quota
// edits, a changed clock, a replacement response or a changed production policy.
export const forumPreviewPolicy={...defaultForumPolicy,new:{...defaultForumPolicy.new,post:100},normal:{...defaultForumPolicy.normal,post:100}};

export async function createForumTopicsPreview({directory,certificate,key,reportDirectory,ports=[5270,5271,5272],verifyPort=5273}={}){
 if(![directory,certificate,key,reportDirectory].every(value=>typeof value==='string'&&isAbsolute(value)))throw Error('forum_preview_absolute_paths_required');
 await mkdir(reportDirectory,{recursive:true});await mkdir(directory,{recursive:true});
 const statusFile=join(reportDirectory,'forum-scene-status.json');let previous=null;
 try{previous=JSON.parse(await readFile(statusFile,'utf8'));if(resolve(previous.directory)!==resolve(directory))throw Error('forum_preview_original_directory_mismatch');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const scene=await createReconstructionFlowPreview({directory,certificate,key,reportDirectory,ports,forumPolicy:forumPreviewPolicy});
 let observer=null;const samples=previous?.samples??[];
 try{
  const db=scene.services.access.db;
  if(!previous){
   const initial=Number((await db.query('SELECT count(*) n FROM forum_posts_v1')).rows[0].n);
   if(initial!==1)throw Error('forum_preview_unrecorded_existing_posts');
   const publish=async(topic,index,{deep=false}={})=>{
    const person=scene.people[index%2],label=forumTopics.find(value=>value.id===topic).label;
    const raw={schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),expectedHeadVersion:0,versionId:randomUUID(),
     title:`[本地合成] ${label} · 阅读样本 ${index+1}`,
     body:deep?'这是一份明确的隔离检索标本。关键词“峡谷橙”只写在这条较早的技术主题正文中，供跨页完整检索使用。':
      `这份${label}讨论是明确标记的本地合成内容，用于正常主题列表、阅读、回复与返回位置的体验检查；不是实际用户发言或工作结果。`,
     links:[],publishedUntil:Math.floor(Date.now()/1000)+7*86400,topic};
    const payload=await bindForumIds('create-post',person.subjectId,raw);
    const authorization=await person.runtime.workerAuthorization.prepareAuthorization(payload,{action:'forum.post.publish',objectId:payload.versionId,
     visibility:'Public',expiresAt:payload.publishedUntil,confirmed:true});
    const result=await person.runtime.api.call('/v2/community/posts',{signedIntent:authorization.signedIntent,payloadJson:authorization.payloadJson});
    const intent=JSON.parse(Buffer.from(authorization.signedIntent.split('.')[1],'base64url').toString('utf8'));
    if(!result.acknowledged||result.postId!==payload.postId)throw Error('forum_preview_post_not_acknowledged');
    const sample={topic,title:payload.title,authorId:person.subjectId,operationId:payload.operationId,postId:payload.postId,versionId:payload.versionId,
     payloadHash:digest(authorization.payloadJson),consentId:intent.id,...(deep?{deepSearch:true,query:'峡谷橙'}:{})};
    samples.push(sample);return sample;
   };
   await publish('technology',0,{deep:true});
   // A real passage of time separates the older target; publication timestamps
   // are never patched and both services and signatures keep the actual clock.
   await new Promise(resolve=>setTimeout(resolve,1100));
   for(let index=1;index<22;index++)await publish('technology',index);
   for(const [offset,topic] of ['arts','learning','life','galaxy'].entries())for(let item=0;item<3;item++)await publish(topic,22+offset*3+item);
  }
  const verification=async()=>({checkedAt:new Date().toISOString(),endpoint:scene.metadata.endpoint,roles:scene.metadata.roles.map(({name,role,subjectId,origin})=>({name,role,subjectId,origin})),
   topics:scene.services.forum.topics(),posts:(await db.query('SELECT id,subject_id,head_version,current_version_id,state,created_at,updated_at FROM forum_posts_v1 ORDER BY created_at DESC,id DESC')).rows,
   versions:(await db.query('SELECT id,post_id,subject_id,version_number,publication_event_id,permission_id,payload_hash,topic,state,created_at,published_until FROM forum_versions_v1 ORDER BY created_at,id')).rows,
   events:(await db.query('SELECT id,subject_id,kind,post_id,version_id,reply_id,consent_id,payload_hash,created_at FROM forum_events_v1 ORDER BY created_at,id')).rows,
   bookmarks:(await db.query('SELECT count(*) n FROM reading_bookmarks_v1')).rows[0],
   boundary:'Read-only object/permission locators and hashes only; no bearer, private key, signature envelope or cached post body.'});
  const observerOrigin='https://127.0.0.1:'+verifyPort;
  observer=createServer({cert:await readFile(certificate),key:await readFile(key)},async(request,response)=>{
   if(request.method!=='GET'||request.url!=='/__forum__/verify'){response.writeHead(404);response.end();return;}
   try{response.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(await verification()));}
   catch{response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:'forum_preview_verification_unavailable'}));}
  });
  await new Promise((resolve,reject)=>{observer.once('error',reject);observer.listen(verifyPort,'127.0.0.1',resolve);});
  const deep=samples.find(value=>value.deepSearch),first=await scene.services.forum.query({topic:'technology',order:'published',limit:20});
  if(!deep||!first.nextAfter||first.items.some(value=>value.locator.postId===deep.postId))throw Error('forum_preview_deep_target_not_after_first_page');
  const found=await scene.services.forum.query({topic:'technology',query:'峡谷橙',order:'published'});
  if(found.items.length!==1||found.items[0].locator.postId!==deep.postId)throw Error('forum_preview_search_target_mismatch');
  const metadata={...scene.metadata,directory,topicCatalog:forumTopics,samples,unclassifiedSource:scene.metadata.forumSource,
   verify:observerOrigin+'/__forum__/verify',forumPolicy:{newPost:100,normalPost:100,defaultNewPost:defaultForumPolicy.new.post,defaultNormalPost:defaultForumPolicy.normal.post,
    reason:'Explicit isolated sample corpus through actual signed API; production configuration is unchanged.'},
   boundaries:{http:'Actual HTTPS/createServices/createApi/Consent and PGlite SQL; no intercepted API responses.',
    identity:'Two synthetic Native identities with real device offers, local visible approval and synthetic real OIDC code/PKCE/ID-token account verification.',
    content:'Initial labelled synthetic work plus 34 normal signed forum publications and one old-format unclassified source; no production content.',
    browser:'Normal /__local__/ visible connection -> fingerprint/scope approval -> /app/community. Browser verification belongs to isolated headless contexts.'}};
  await writeFile(statusFile,JSON.stringify(metadata,null,2));await writeFile(join(reportDirectory,'forum-scene-seeded-verify.json'),JSON.stringify(await verification(),null,2));
  return{metadata,verification,close:async()=>{if(observer){observer.closeAllConnections();await new Promise(resolve=>observer.close(resolve));}
   await writeFile(join(reportDirectory,'shared-scene-before-reload-verify.json'),JSON.stringify(await scene.verification(),null,2));await scene.close();}};
 }catch(error){if(observer){observer.closeAllConnections();await new Promise(resolve=>observer.close(resolve));}await scene.close();throw error;}
}

if(process.argv.includes('--preview')&&resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const scene=await createForumTopicsPreview({directory:process.env.GALAXY_FORUM_DATA_DIRECTORY,certificate:process.env.GALAXY_FORUM_TLS_CERT,
  key:process.env.GALAXY_FORUM_TLS_KEY,reportDirectory:process.env.GALAXY_FORUM_REPORT_DIRECTORY});
 process.stdout.write(JSON.stringify({pid:process.pid,entries:scene.metadata.roles.map(value=>value.entry),api:scene.metadata.endpoint,verify:scene.metadata.verify})+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void scene.close().then(()=>process.exit(0)));
}
