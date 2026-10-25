import {governanceReceiptIntent} from '../../../../packages/galaxy-official/src/shared/operations-governance-receipt-intent.mjs';
import {operationsRequest} from './operations-client';

export const governanceRecoveryPendingMessage='处理时间比平时长，内容已保留。';

type Intent=Readonly<{path:string;body:Record<string,unknown>}>;
type BatchOutcome={kind:'post'|'reply';id:string;status:'applied'|'rejected';code:string|null};
export type GovernanceRecovered={recovered:true;operationId:string;action:string;targetId:string|null;targetKind:string|null;version:number|null;sourceVersion:number|null;recordedAt:string;items:BatchOutcome[];counts:{applied:number;rejected:number}|null};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable=()=>Error('原操作结果尚未确认，正在继续核对原记录。');
const verifiedRecovery=new WeakSet<object>();

export async function governanceRecoveryReceipt(intent:Intent,value:unknown):Promise<GovernanceRecovered|null>{
 const original=await governanceReceiptIntent(intent.path,intent.body);
 if(!object(value)||value.operationId!==original.operationId||value.metadataOnly!==true||!integer(value.checkedAt)||!integer(value.readExpiresAt)||value.readExpiresAt<=Date.now()/1000||value.readExpiresAt>value.checkedAt+30)throw unavailable();
 if(value.state==='not-recorded'||value.state==='unknown')return null;
 if(value.state!=='recorded'||value.kind!==original.action||!object(value.result))throw unavailable();
 const r=value.result,s=original.selection;
 if(r.intentHash!==original.intentHash||typeof r.recordedAt!=='string'||!Number.isFinite(Date.parse(r.recordedAt)))throw unavailable();
 const result:GovernanceRecovered={recovered:true,operationId:original.operationId,action:original.action,targetId:null,targetKind:null,version:null,sourceVersion:null,recordedAt:r.recordedAt,items:[],counts:null};
 const target=(id:unknown,kind:unknown,version:unknown,source:unknown=null)=>{
  if(typeof id!=='string'||kind!==null&&typeof kind!=='string'||!integer(version)||version<1||source!==null&&!integer(source))throw unavailable();
  result.targetId=id;result.targetKind=typeof kind==='string'?kind:null;result.version=version;result.sourceVersion=typeof source==='number'?source:null;
 };
 if(original.action==='community-report-resolve'){
  if(r.reportId!==s.id||r.version!==s.expectedVersion+1||r.state!=='resolved'||r.resolution!==s.resolution)throw unavailable();
  target(r.reportId,'case',r.version);
 }else if(original.action==='community-section-classify'){
  if(r.sectionId!==s.id||r.version!==s.expectedVersion+1||r.category!==s.category)throw unavailable();
  target(r.sectionId,'section',r.version);
 }else if(original.action==='community-section-visibility'||original.action==='resource-visibility'){
  const x=original.action==='resource-visibility'?s.command:s;
  if(!object(r.target)||r.target.id!==s.id||r.target.kind!==(original.action==='resource-visibility'?(s.kind==='projects'?'project':'method'):'forum-section')||!object(r.visibility)||r.visibility.version!==x.expectedVisibilityVersion+1||r.visibility.operationId!==original.operationId||r.sourceVersion!==x.expectedVersion)throw unavailable();
  target(r.target.id,r.target.kind,r.visibility.version,r.sourceVersion);
 }else if(original.action==='community-content-curation'){
  if(r.id!==s.id||r.kind!==s.kind||r.revision!==s.expectedRevision+1||r.sourceVersion!==s.expectedVersion)throw unavailable();
  target(r.id,r.kind,r.revision,r.sourceVersion);
 }else if(original.action==='community-content-visibility'){
  if(r.id!==s.id||r.kind!==s.targetKind||!object(r.visibility)||r.visibility.version!==s.expectedRevision+1||r.visibility.operationId!==original.operationId)throw unavailable();
  target(r.id,r.kind,r.visibility.version,s.expectedVersion);
 }else if(original.action==='community-tag-create'||original.action==='community-tag-update'){
  if(!object(r.tag)||s.id&&r.tag.id!==s.id||r.tag.version!==(s.expectedVersion??0)+1)throw unavailable();
  target(r.tag.id,'tag',r.tag.version);
 }else if(original.action==='community-content-batch-visibility'){
  if(!Array.isArray(r.items)||!Array.isArray(s.items)||r.items.length!==s.items.length||!object(r.counts)||!integer(r.counts.applied)||!integer(r.counts.rejected)||r.counts.applied+r.counts.rejected!==r.items.length)throw unavailable();
  for(let index=0;index<r.items.length;index++){
   const item:unknown=r.items[index],input:unknown=s.items[index];
   if(!object(item)||!object(input)||item.id!==input.id||item.kind!==input.kind||typeof item.id!=='string'||item.kind!=='post'&&item.kind!=='reply'||item.status!=='applied'&&item.status!=='rejected'||item.code!==null&&typeof item.code!=='string')throw unavailable();
   result.items.push({kind:item.kind,id:item.id,status:item.status,code:typeof item.code==='string'?item.code:null});
  }
  if(r.counts.applied!==result.items.filter(item=>item.status==='applied').length)throw unavailable();
  result.counts={applied:r.counts.applied,rejected:r.counts.rejected};
 }else throw unavailable();
 verifiedRecovery.add(result);return result;
}

/** Once attempted, missing/unknown/denied records stay GET-only. In particular
 * never return the shared hook's legacy not-recorded => POST branch. */
export async function recoverGovernanceCommand(intent:Intent,{signal}:{signal:AbortSignal}):Promise<{state:'recorded';value:GovernanceRecovered}>{
 try{
  const original=await governanceReceiptIntent(intent.path,intent.body);
  const value=await operationsRequest<unknown>(original.receiptPath,{signal});
  const recovered=await governanceRecoveryReceipt(intent,value);
  if(!recovered)throw unavailable();
  return{state:'recorded',value:recovered};
 }catch{throw unavailable();}
}
export function isGovernanceRecovered(value:unknown):value is GovernanceRecovered{return object(value)&&value.recovered===true;}
export function validateGovernanceOperation(value:unknown,intent:Intent){
 if(!object(value)||typeof intent.body.operationId!=='string'||!uuid.test(intent.body.operationId)||value.operationId!==intent.body.operationId)throw unavailable();
 if(isGovernanceRecovered(value)){if(!verifiedRecovery.has(value))throw unavailable();return;}
 const p=intent.path.split('/'),b=intent.body,next=(value:unknown,base:unknown)=>integer(value)&&integer(base)&&value===base+1;
 const visibility=(value:unknown,expected:unknown)=>object(value)&&next(value.version,expected)&&value.operationId===b.operationId&&value.hidden===(b.kind==='hide')&&value.until===(b.kind==='hide'&&integer(b.until)?new Date(b.until*1000).toISOString():null);
 if(p[0]!==''||p[1]!=='v1'||p[2]!=='operations')throw unavailable();
 if(p.length===7&&p[3]==='community'&&p[4]==='reports'&&p[6]==='resolve'){
  const action=b.restrictionAction??(b.hideUntil!==undefined?'hide':'keep');
  if(value.reportId!==p[5]||!next(value.version,b.expectedVersion)||value.state!=='resolved'||value.resolution!==b.resolution||value.restrictionAction!==action||action==='release'&&(value.effectUntil!==null||value.restrictionEventId!==null)||action==='hide'&&(!integer(b.hideUntil)||value.effectUntil!==new Date(b.hideUntil*1000).toISOString()||value.restrictionEventId!==b.operationId))throw unavailable();
 }else if(p.length===7&&p[3]==='community'&&p[4]==='sections'&&p[6]==='classification'){
  if(value.sectionId!==p[5]||!next(value.version,b.expectedVersion)||value.category!==b.category)throw unavailable();
 }else if(p.length===7&&(p[3]==='community'&&p[4]==='sections'||p[3]==='resources'&&['projects','methods'].includes(p[4]))&&p[6]==='visibility'){
  const kind=p[3]==='resources'?(p[4]==='projects'?'project':'method'):'forum-section';
  if(!object(value.target)||value.target.id!==p[5]||value.target.kind!==kind||value.sourceVersion!==b.expectedVersion||value.sourcePermissionChanged!==false||!visibility(value.visibility,b.expectedVisibilityVersion))throw unavailable();
 }else if(p.length===8&&p[3]==='community'&&p[4]==='content'&&['post','reply'].includes(p[5])&&['curation','visibility'].includes(p[7])){
  if(!object(value.content)||value.content.id!==p[6]||value.content.kind!==p[5]||value.content.version!==b.expectedVersion)throw unavailable();
  if(p[7]==='visibility'){if(!visibility(value.content.visibility,b.expectedRevision))throw unavailable();}
  else{
   const c=value.content.curation;
   if(!object(c)||!next(c.revision,b.expectedRevision)||c.sourceVersion!==b.expectedVersion)throw unavailable();
   for(const field of ['topic','pinned','featured'])if(Object.hasOwn(b,field)&&c[field]!==b[field])throw unavailable();
   if(Object.hasOwn(b,'tagIds')&&(!Array.isArray(c.tagIds)||!Array.isArray(b.tagIds)||JSON.stringify([...c.tagIds].sort())!==JSON.stringify([...b.tagIds].sort())))throw unavailable();
  }
 }else if(p[3]==='community'&&p[4]==='tags'&&(p.length===5||p.length===6)){
  const tag=value.tag;
  if(!object(tag)||typeof tag.id!=='string'||!uuid.test(tag.id)||p.length===6&&tag.id!==p[5]||!next(tag.version,p.length===5?0:b.expectedVersion)||typeof b.name==='string'&&tag.name!==b.name.trim()||typeof b.enabled==='boolean'&&tag.enabled!==b.enabled)throw unavailable();
 }else if(p.length===7&&p[3]==='community'&&p[4]==='content'&&p[5]==='visibility'&&p[6]==='batch'){
  if(!Array.isArray(value.items)||!Array.isArray(b.items)||value.items.length!==b.items.length||!object(value.counts)||!integer(value.counts.applied)||!integer(value.counts.rejected)||value.counts.applied+value.counts.rejected!==value.items.length)throw unavailable();
  let applied=0;
  for(let index=0;index<value.items.length;index++){
   const result:unknown=value.items[index],input:unknown=b.items[index];
   if(!object(result)||!object(input)||result.id!==input.id||result.kind!==input.kind||result.status!=='applied'&&result.status!=='rejected')throw unavailable();
   if(result.status==='applied'){applied++;if(!visibility(result.visibility,input.expectedRevision))throw unavailable();}
  }
  if(applied!==value.counts.applied)throw unavailable();
 }else throw unavailable();
}

