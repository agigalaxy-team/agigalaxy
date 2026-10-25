import {z} from 'zod';
import {ServiceError} from './shared/service-error.mjs';
import {operationsResourcesQuerySchema,operationsVisibilitySchema} from './shared/operations-business-schema.mjs';
import {OperationsBusinessDomain,operationsVisibilityWithin,operationsParse,operationsFail,operationsIso} from './operations-content-visibility.mjs';
import {hasOperationsPermission as permitted} from './operations-permission-catalog.mjs';

const unavailable=error=>error instanceof ServiceError&&[403,404,409,410,422].includes(error.status);
export class OperationsResourcesService extends OperationsBusinessDomain {
 constructor({businessAdmin,projects,capsules,maxHideSeconds,now}){super({businessAdmin,now});Object.assign(this,{projects,capsules,maxHideSeconds});}
 kind(kind){if(!['projects','methods'].includes(kind))operationsFail('not_found',404);return kind==='projects'?'project':'method';}
 async rowWithin(db,kind,id,{lock=false}={}){
  operationsParse(z.uuid(),id);this.kind(kind);
  const row=(await db.query(`SELECT * FROM ${kind==='projects'?'projects_v2':'capsules'} WHERE id=$1${lock?' FOR UPDATE':' FOR SHARE'}`,[id])).rows[0];
  if(!row)operationsFail('not_found',404);return row;
 }
 async sourceWithin(db,kind,row){
  try{
   if(kind==='projects'){
    const view=await this.projects.readWithin(db,null,row.id,{ignoreOperationsVisibility:true});
    return {state:'available',title:view.document.title,content:{document:view.document,source:view.source},readPermission:'current-public-source'};
   }
   const view=await this.capsules.versionWithin(db,null,row.id,null,{ignoreOperationsVisibility:true});
   if(view.sourceStatus==='source-unavailable')return {state:'unavailable',title:null,content:null,readPermission:'current-public-source'};
   const p=view.payload;
   return {state:'available',title:p.title,content:{versionId:view.row.id,version:p.version,title:p.title,problemPattern:p.problemPattern,
    environment:p.environment,solutionStrategy:p.solutionStrategy,tools:p.tools,skills:p.skills,mcpRefs:p.mcpRefs,
    verificationMethod:p.verificationMethod,limitations:p.limitations,applicableScope:p.applicableScope,license:p.license,
    deprecated:view.deprecated,securityIssue:view.securityIssue,sourceStatus:view.sourceStatus},readPermission:'current-public-source'};
  }catch(error){if(!unavailable(error))throw error;return {state:'unavailable',title:null,content:null,readPermission:'current-public-source'};}
 }
 async viewWithin(db,kind,row,{detail=false,operator}={}){
  const resourceKind=this.kind(kind),source=await this.sourceWithin(db,kind,row),visibility=await operationsVisibilityWithin(db,{endpoint:this.endpoint,kind:resourceKind,id:row.id,now:this.now()});
  let maintenance=null;if(kind==='methods'){const latest=(await db.query("SELECT id FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY revision DESC LIMIT 1",[row.id])).rows[0];if(latest)maintenance=await this.capsules.maintenanceWithin(db,null,row.id,latest.id);}
  return {id:row.id,kind:resourceKind,version:row.revision,ownerId:row.owner_id??row.subject_id,creatorId:row.creator_id??row.subject_id,
   state:row.state??(maintenance?.deprecated?'deprecated':'recorded'),...(kind==='methods'?{deprecated:maintenance?.deprecated??null,securityIssue:maintenance?.securityIssue??null}:{}),createdAt:operationsIso(row.created_at),updatedAt:operationsIso(row.updated_at),title:source.title,
   sourceState:source.state,visibility,canManage:permitted(operator,'resources.hide')||permitted(operator,'resources.restore'),
   canHide:permitted(operator,'resources.hide')&&!visibility.hidden&&source.state==='available'&&(!row.state||row.state==='active'),canRestore:permitted(operator,'resources.restore')&&visibility.hidden,maxHideSeconds:this.maxHideSeconds,
   ...(detail?{publicContent:source.content,readPermission:source.readPermission,privateMaterialsGranted:false}:{}),checkedAt:this.now()};
 }
 list(operator,kind,input={}){const q=operationsParse(operationsResourcesQuerySchema,input);this.kind(kind);if(kind==='methods'&&q.state!==undefined)operationsFail('invalid_operations_request',400);
  return this.run(operator,false,'resources-query',{kind,...q},async(db,actor)=>{
   const rows=(await db.query(`SELECT * FROM ${kind==='projects'?'projects_v2':'capsules'} WHERE ($1::uuid IS NULL OR id>$1)
    ${kind==='projects'?'AND ($3::text IS NULL OR state=$3)':''} ORDER BY id LIMIT $2`,kind==='projects'?[q.after??null,q.limit+1,q.state??null]:[q.after??null,q.limit+1])).rows;
   const selected=rows.slice(0,q.limit),items=[];for(const row of selected)items.push(await this.viewWithin(db,kind,row,{operator:actor}));
   return {items,nextAfter:rows.length>q.limit?selected.at(-1).id:null,checkedAt:this.now()};
  });
 }
 get(operator,kind,id){this.kind(kind);return this.run(operator,false,'resource-read',{kind,id},async(db,actor)=>this.viewWithin(db,kind,await this.rowWithin(db,kind,id),{detail:true,operator:actor}));}
 visibility(operator,kind,id,input){const x=operationsParse(operationsVisibilitySchema,input),resourceKind=this.kind(kind);operationsParse(z.uuid(),id);
  return this.command(operator,'resource-visibility',{kind,id,command:x,operationId:x.operationId},async db=>{
   const row=await this.rowWithin(db,kind,id,{lock:true});
   // A restore removes only the operator layer. It never restores an archived
   // project, withdrawn method, expired grant, or unavailable source material.
   if(x.kind==='hide'&&(row.state&&row.state!=='active'||(await this.sourceWithin(db,kind,row)).state!=='available'))operationsFail('operations_source_unavailable');
   return this.changeVisibilityWithin(db,{kind:resourceKind,id,sourceVersion:row.revision,expectedVersion:x.expectedVersion,input:x});
  });
 }
}
