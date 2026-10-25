import {z} from "zod";
import {OperationsBusinessDomain,operationsParse,operationsFail} from "../../operations-content-visibility.mjs";

// Original endpoint ownership, retained public-shape proof and current source/parent qualification. Retained prose never grants read permission.
export class PublicContentSource extends OperationsBusinessDomain{
 constructor({businessAdmin,forum,now}){super({businessAdmin,now});this.forum=forum;this.maxHideSeconds=forum.policy.maxGovernanceHideSeconds;}
 async versionMetadataWithin(db,postId,versionId=null,lock=false){
  // A missing current reference may locate only the latest retained version.
  // Selection never falls back to an older public version and never reads prose.
  return (await db.query(`SELECT v.*,e.erased_at AS event_erased FROM forum_versions_v1 v LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id
   WHERE v.post_id=$1 AND ($2::uuid IS NULL OR v.id=$2) ORDER BY v.version_number DESC LIMIT 1${lock?' FOR UPDATE OF v':''}`,[postId,versionId])).rows[0]??null;
 }
 async rawWithin(db,kind,id,{lock=false}={}){
  operationsParse(z.enum(['post','reply']),kind);operationsParse(z.uuid(),id);
  const head=kind==='post'?await this.forum.head(db,id,lock):(await db.query(`SELECT r.*,e.erased_at AS event_erased FROM forum_replies_v1 r
   LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1${lock?' FOR UPDATE OF r':''}`,[id])).rows[0];
  if(!head)operationsFail('not_found',404);
  const source=kind==='post'?await this.versionMetadataWithin(db,id,head.current_version_id,lock):head;
  const belongs=head.account_id?(await db.query('SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2',[head.account_id,this.endpoint])).rows.length
   :head.subject_id&&source?.permission_id&&(await db.query(`SELECT 1 FROM forum_permissions_v1 permission JOIN consents c ON c.id=permission.consent_id
    WHERE permission.id=$1 AND permission.subject_id=$2 AND c.intent->>'subjectId'=$2 AND c.intent->>'endpoint'=$3 AND c.intent->>'recipient'=$3`,[source.permission_id,head.subject_id,this.endpoint])).rows.length;
  if(!belongs)operationsFail('not_found',404);
  return {head,source};
 }
 async publicSourceWithin(db,kind,head,source){
  if(!source)return {candidate:false,available:false,payload:null,parent:null};
  const audience=source.audience??{read:{kind:'everyone'}};
  let candidate=audience.read?.kind==='everyone',parent=null;
  if(source.section_id){const section=await this.forum.accessRules.sectionWithin(db,source.section_id);candidate&&=!!section&&section.audience.read?.kind==='everyone';}
  if(kind==='reply'){
   parent=await this.versionMetadataWithin(db,source.post_id,source.post_version_id);
   candidate&&=!!parent&&(parent.audience?.read?.kind??'everyone')==='everyone';
  }
  if(!candidate)return {candidate:false,available:false,payload:null,parent};
  if(head.state!=='published'||source.state!=='published'||head.erased_at||source.erased_at||source.event_erased||kind==='post'&&head.current_version_id!==source.id)
   return {candidate:true,available:false,payload:null,parent};
  const permission=await this.forum.permissions.statusWithin(db,source.permission_id,{visibility:'Public',payloadHash:source.payload_hash,
   action:kind==='post'?'forum.post.publish':'forum.reply.publish',objectId:source.id,viewerActor:null,ignoreOperationsVisibility:true,lock:false});
  if(!permission.allowed)return {candidate:true,available:false,payload:null,parent};
  const event=(await db.query('SELECT payload_text,erased_at FROM forum_events_v1 WHERE id=$1',[source.publication_event_id])).rows[0];
  if(!event?.payload_text||event.erased_at)return {candidate:true,available:false,payload:null,parent};
  const payload=JSON.parse(event.payload_text);
  if(kind==='post'&&(source.topic??null)!==(payload.topic??null))return {candidate:true,available:false,payload:null,parent};
  // A reply keeps its own accepted publication permission. Parent-derived
  // presentation still needs the parent's current read permission; retained
  // parent bytes alone never authorize an old title or category projection.
  const parentView=kind==='reply'?await this.forum.readVersionWithin(db,source.post_id,source.post_version_id):null;
  return {candidate:true,available:true,payload,parent,parentView};
 }
 async caseHiddenWithin(db,kind,head,source){
  const governance=this.forum.governance;if(!governance)return false;
  const target=kind==='post'?{kind:'post-version',postId:head.id,versionId:source.id}:{kind:'reply',replyId:head.id,contentRevision:1};
  if(await governance.hiddenWithin(db,target))return true;
  return kind==='reply'&&await governance.hiddenWithin(db,{kind:'post-version',postId:head.post_id,versionId:head.post_version_id});
 }
}
