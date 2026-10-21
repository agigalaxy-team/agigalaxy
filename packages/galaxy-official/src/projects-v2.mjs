import canonicalize from 'canonicalize';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { projectEventV2Schema, projectEnvelopeV2Schema, projectDocumentV2Schema, projectPreferenceV2Schema, projectDirectoryQueryV2Schema, projectPortfolioQueryV2Schema } from './shared/projects-schema-v2.mjs';
import { discoveryPreferencesSchema, defaultDiscoveryPreferences } from './shared/discovery-schema.mjs';
import { effectiveDiscovery, normalizeFunction } from './domain/discovery-match.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { transaction } from './database.mjs';
import {operationsVisibilityWithin} from './operations-content-visibility.mjs';

const fail = (code,status=409) => {throw new ServiceError(code,status);};
const stamp = now => new Date(now*1000).toISOString();
const parse = (schema,input) => {const result=schema.safeParse(input);if(!result.success)fail('invalid_project_request',400);return result.data;};
const unavailable = error => error instanceof ServiceError && [403,404].includes(error.status);
const directoryWindowSize = 200, directoryCursorSeconds = 900;
const directoryFields = ['kind','title','summary','functions','technologies','participantKind','sourceUrl'];

export class ProjectV2Service {
  constructor(access,{consents,profiles,notifications,requireAccountWithin=null}={}) {Object.assign(this,{access,consents,profiles,notifications,requireAccountWithin});this.directoryCursorKey=randomBytes(32);}
  run(actor,fn,{write=false}={}) {return actor ? write ? this.access.runResourceWrite(actor,'history',{},fn) : this.access.runAuthorized(actor,'history',fn) : transaction(this.access.db,fn);}
  async grantWithin(db,event) {
    if(!event?.payload_text)fail('project_source_unavailable',404);
    return this.consents.require(db,{id:event.consent_id,subjectId:event.subject_id,action:'project.write',objectId:event.operation_id,
      recipient:this.access.endpoint,payloadJson:event.payload_text});
  }
  async rowWithin(db,id,{write=false}={}) {
    const row=(await db.query(`SELECT * FROM projects_v2 WHERE id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[id])).rows[0];
    if(!row)fail('project_not_found',404);return row;
  }
  async rolesWithin(db,project,subjectId) {
    if(project.owner_id===subjectId)return ['owner'];
    const rows=(await db.query(`SELECT r.role,e.* FROM project_roles_v2 r JOIN project_events_v2 e ON e.operation_id=r.grant_event_id
      WHERE r.project_id=$1 AND r.subject_id=$2 AND r.state='active'`,[project.id,subjectId])).rows;
    const roles=[];
    for(const row of rows) {try {await this.grantWithin(db,row);roles.push(row.role);}catch(error){if(!unavailable(error))throw error;}}
    return roles;
  }
  async requireRoleWithin(db,actor,projectId,allowed,{write=false}={}) {
    const project=await this.rowWithin(db,projectId,{write}),roles=await this.rolesWithin(db,project,actor?.subjectId);
    if(!roles.some(role=>allowed.includes(role)))fail('project_role_required',403);
    return project;
  }
  async documentWithin(db,actor,project,{allowPartial=false}={}) {
    const rows=(await db.query("SELECT * FROM project_events_v2 WHERE project_id=$1 AND kind IN ('create','revise') ORDER BY revision",[project.id])).rows;
    const fields=new Map(),sources=new Map();
    for(const row of rows) {
      if(!row.payload_text){for(const key of row.affected_fields){fields.set(key,null);sources.set(key,row);}continue;}
      const event=parse(projectEventV2Schema,JSON.parse(row.payload_text));
      // Keep each field's final writer so a revoked patch never resurrects an
      // older value and unrelated authors are not rewritten into one owner.
      for(const [key,value]of Object.entries(event.kind==='create'?event.document:event.patch)) {
        if(key==='sourceUrl'&&value===null){fields.delete(key);sources.delete(key);}
        else{fields.set(key,value);sources.set(key,row);}
      }
    }
    const visible=new Map(),checked=new Map();
    for(const [key,value]of fields) {
      const row=sources.get(key);
      if(!checked.has(row.operation_id)) {
        try {const grant=await this.grantWithin(db,row);checked.set(row.operation_id,canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()}));}
        catch(error){if(!unavailable(error))throw error;checked.set(row.operation_id,false);}
      }
      if(checked.get(row.operation_id))visible.set(key,value);
    }
    const raw=Object.fromEntries(visible),result=projectDocumentV2Schema.safeParse(raw);
    if(!result.success&&!allowPartial)fail('project_source_unavailable',404);
    return {document:result.success?result.data:raw,fields:[...visible.keys()].map(field=>({field,operationId:sources.get(field).operation_id,subjectId:sources.get(field).subject_id}))};
  }
  async readWithin(db,actor,projectId,{includeArchived=false,ignoreOperationsVisibility=false}={}) {
    const project=await this.rowWithin(db,projectId),own=actor?.subjectId===project.owner_id;
    if(project.state!=='active'&&!(includeArchived&&own))fail('project_not_found',404);
    const policy=(await db.query('SELECT * FROM project_events_v2 WHERE operation_id=$1',[project.policy_event_id])).rows[0];
    const grant=await this.grantWithin(db,policy);
    if(!canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()}))fail('project_not_found',404);
    const roles=actor?await this.rolesWithin(db,project,actor.subjectId):[],operationsVisibility=await operationsVisibilityWithin(db,{endpoint:this.access.endpoint,kind:'project',id:projectId,now:this.access.now()});
    if(operationsVisibility.hidden&&!ignoreOperationsVisibility&&!roles.length)fail('project_not_found',404);
    const material=await this.documentWithin(db,actor,project);
    return {schemaVersion:2,projectId,ownerId:project.owner_id,creatorId:project.creator_id,revision:project.revision,state:project.state,
      document:material.document,visibility:grant.visibility,...(roles.length?{operationsVisibility}:{}),classification:'self-declared',capabilityVerified:false,legalOwnershipVerified:false,
      source:{documentEventId:project.document_event_id,policyEventId:project.policy_event_id,sourceStatementId:project.source_statement_id,fieldSources:material.fields},
      ownRoles:roles,permissions:{edit:roles.some(r=>['owner','editor'].includes(r)),represent:roles.some(r=>['owner','representative'].includes(r)),
        manage:roles.includes('owner'),privateFiles:false,agentControl:false}};
  }
  async managementWithin(db,actor,project) {
    const owner=project.owner_id===actor?.subjectId,transfers=[];
    for(const row of (await db.query("SELECT * FROM project_transfers_v2 WHERE project_id=$1 AND state='offered' AND ($2 OR to_subject_id=$3)",[project.id,owner,actor?.subjectId??null])).rows) {
      if(row.from_subject_id!==project.owner_id||project.state!=='active')continue;
      try {const grant=await this.grantWithin(db,(await db.query('SELECT * FROM project_events_v2 WHERE operation_id=$1',[row.offer_event_id])).rows[0]);
        if(!canReadProjection(grant,{viewerId:actor?.subjectId??null,projection:'history',now:this.access.now()}))continue;
        transfers.push({transferId:row.id,fromSubjectId:row.from_subject_id,toSubjectId:row.to_subject_id,state:'offered',operationId:row.offer_event_id});
      }catch(error){if(!unavailable(error))throw error;}
    }
    const roles=[];
    if(owner)for(const row of (await db.query("SELECT * FROM project_roles_v2 WHERE project_id=$1 AND state='active' ORDER BY subject_id,role",[project.id])).rows) {
      if((await this.rolesWithin(db,project,row.subject_id)).includes(row.role))roles.push({subjectId:row.subject_id,role:row.role,grantOperationId:row.grant_event_id});
    }
    return {roles,transfers};
  }
  async workspaceWithin(db,actor,projectId) {
    const row=await this.rowWithin(db,projectId),management=await this.managementWithin(db,actor,row);
    try {return {...await this.readWithin(db,actor,projectId,{includeArchived:true}),management};}
    catch(error){if(!unavailable(error)||!management.transfers.some(t=>t.toSubjectId===actor?.subjectId))throw error;
      return {schemaVersion:2,projectId,revision:row.revision,state:row.state,ownerId:row.owner_id,document:null,contentUnavailable:true,
        ownRoles:[],permissions:{edit:false,represent:false,manage:false},management,
        transferMeaning:'pending-offer-only; original-document-access-still-required-for-acceptance'};
    }
  }
  get(actor,projectId) {return this.run(actor,db=>this.workspaceWithin(db,actor,projectId));}
  list(actor,{after='',limit=50}={}) {
    if(!actor)fail('access_denied',401);
    if(!Number.isInteger(limit)||limit<1||limit>100||after&&!/^[a-f0-9-]{36}$/i.test(after))fail('invalid_project_request',400);
    return this.run(actor,async db=>{
      const rows=(await db.query(`SELECT DISTINCT p.id FROM projects_v2 p LEFT JOIN project_roles_v2 r ON r.project_id=p.id
        WHERE (p.owner_id=$1 OR (r.subject_id=$1 AND r.state='active') OR EXISTS(SELECT 1 FROM project_transfers_v2 t WHERE t.project_id=p.id AND t.to_subject_id=$1 AND t.state='offered' AND t.from_subject_id=p.owner_id)) AND ($2='' OR p.id::text>$2)
        ORDER BY p.id LIMIT $3`,[actor.subjectId,after,limit+1])).rows,items=[];
      for(const row of rows.slice(0,limit)){try{const view=await this.workspaceWithin(db,actor,row.id);
        if(view.ownRoles.length||view.management.transfers.some(t=>t.toSubjectId===actor.subjectId))items.push(view);
      }catch(error){if(!unavailable(error))throw error;}}
      return {items,nextAfter:rows.length>limit?rows[limit-1].id:null};
    });
  }
  async submit(actor,input) {
    const envelope=parse(projectEnvelopeV2Schema,input);let event;
    try{event=parse(projectEventV2Schema,JSON.parse(envelope.payloadJson));}catch{fail('invalid_project_request',400);}
    return this.run(actor,async(db,authorization)=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912358))',[event.projectId]);
      const prior=(await db.query('SELECT * FROM project_events_v2 WHERE operation_id=$1',[event.operationId])).rows[0];
      if(prior){if(prior.subject_id!==actor.subjectId||prior.project_id!==event.projectId||prior.consent_id!==envelope.consentId||prior.payload_hash!==digest(envelope.payloadJson))fail('project_operation_conflict');
        return {operationId:event.operationId,projectId:event.projectId,revision:prior.revision,applied:true,replayed:true};}
      const source={operation_id:event.operationId,subject_id:actor.subjectId,consent_id:envelope.consentId,payload_text:envelope.payloadJson};
      const grant=await this.grantWithin(db,source);
      if(!['Public','Private'].includes(grant.visibility)||grant.currentVisibility?.deletionPending)fail('project_write_unavailable',403);
      if(grant.visibility==='Public') {if(!this.requireAccountWithin)fail('project_account_adapter_unavailable',503);await this.requireAccountWithin(db,actor);}
      let project,document,transfer;
      if(event.kind==='create') {
        if(event.expectedRevision!==0)fail('project_revision_conflict');
        if((await db.query('SELECT id FROM projects_v2 WHERE id=$1',[event.projectId])).rows.length)fail('project_id_conflict');
        document=event.document;
        if(event.sourceStatementId) {
          const profile=await this.profiles.readWithin(db,actor,actor.subjectId),old=profile.selfDeclared.projects?.find(p=>p.id===event.projectId);
          if(!old||profile.selfDeclaredSource?.id!==event.sourceStatementId)fail('project_import_source_unavailable',404);
          const {id:_id,...original}=old;
          if(canonicalize(projectDocumentV2Schema.parse(original))!==canonicalize(document))fail('project_import_must_preserve_source',400);
        }
      } else {
        project=await this.rowWithin(db,event.projectId,{write:true});
        if(project.revision!==event.expectedRevision)fail('project_revision_conflict');
        const roles=await this.rolesWithin(db,project,actor.subjectId),owner=roles.includes('owner');
        if(event.kind==='revise') {
          if(!owner&&!roles.includes('editor'))fail('project_editor_required',403);
          const previous=owner?await this.documentWithin(db,actor,project,{allowPartial:true}):await this.readWithin(db,actor,project.id);
          const merged={...previous.document,...event.patch};if(merged.sourceUrl===null)delete merged.sourceUrl;
          document=projectDocumentV2Schema.parse(merged);
          if(!owner&&['discoverable','participantKind'].some(key=>Object.hasOwn(event.patch,key)))fail('project_owner_setting_required',403);
        } else if(event.kind==='accept-transfer') {
          transfer=(await db.query('SELECT * FROM project_transfers_v2 WHERE id=$1 AND project_id=$2 FOR UPDATE',[event.transferId,project.id])).rows[0];
          if(!transfer||transfer.state!=='offered'||transfer.to_subject_id!==actor.subjectId||transfer.from_subject_id!==project.owner_id)fail('project_transfer_unavailable');
          await this.grantWithin(db,(await db.query('SELECT * FROM project_events_v2 WHERE operation_id=$1',[transfer.offer_event_id])).rows[0]);
          await this.readWithin(db,actor,project.id);
        } else if(!owner)fail('project_owner_required',403);
        if(project.state!=='active'&&!['restore','cancel-transfer'].includes(event.kind))fail('project_archived');
        if(event.kind==='grant-role') {
          if(event.subjectId===project.owner_id)fail('project_owner_role_implicit');
          const managed=(await db.query("SELECT DISTINCT subject_id FROM project_roles_v2 WHERE project_id=$1 AND state='active'",[project.id])).rows;
          if(managed.length>=9&&!managed.some(r=>r.subject_id===event.subjectId))fail('project_manager_limit');
        }
        if(event.kind==='offer-transfer'&&(event.toSubjectId===project.owner_id||(await db.query("SELECT id FROM project_transfers_v2 WHERE project_id=$1 AND state='offered'",[project.id])).rows.length))fail('project_transfer_conflict');
        if(event.kind==='cancel-transfer') {
          transfer=(await db.query('SELECT * FROM project_transfers_v2 WHERE id=$1 AND project_id=$2 FOR UPDATE',[event.transferId,project.id])).rows[0];
          if(!transfer||transfer.state!=='offered'||transfer.from_subject_id!==project.owner_id)fail('project_transfer_unavailable');
        }
      }
      if(document&&JSON.stringify(document).length>14000)fail('project_document_too_large',413);
      const revision=event.expectedRevision+1,at=stamp(this.access.now());
      if(event.kind==='create')await db.query(`INSERT INTO projects_v2(id,creator_id,owner_id,revision,state,document_event_id,policy_event_id,source_statement_id,created_at,updated_at)
        VALUES($1,$2,$2,1,'active',$3,$3,$4,$5,$5)`,[event.projectId,actor.subjectId,event.operationId,event.sourceStatementId??null,at]);
      await db.query(`INSERT INTO project_events_v2(operation_id,project_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,affected_fields,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[event.operationId,event.projectId,actor.subjectId,revision,event.kind,envelope.consentId,envelope.payloadJson,digest(envelope.payloadJson),JSON.stringify(Object.keys(event.kind==='create'?event.document:event.kind==='revise'?event.patch:{})),at]);
      const changedFields=Object.keys(event.kind==='create'?event.document:event.kind==='revise'?event.patch:{});
      if(event.kind==='create'||event.kind==='accept-transfer'||event.kind==='revise'&&project.owner_id===actor.subjectId)changedFields.push('@policy');
      for(const field of changedFields)await db.query(`INSERT INTO project_field_sources_v2(project_id,field_name,event_id) VALUES($1,$2,$3)
        ON CONFLICT(project_id,field_name) DO UPDATE SET event_id=$3`,[event.projectId,field,event.operationId]);
      if(event.kind!=='create')await db.query('UPDATE projects_v2 SET revision=$2,updated_at=$3 WHERE id=$1',[event.projectId,revision,at]);
      if(event.kind==='revise')await db.query(`UPDATE projects_v2 SET document_event_id=$2,policy_event_id=CASE WHEN owner_id=$3 THEN $2 ELSE policy_event_id END WHERE id=$1`,[event.projectId,event.operationId,actor.subjectId]);
      if(event.kind==='grant-role')await db.query(`INSERT INTO project_roles_v2(project_id,subject_id,role,grant_event_id,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,'active',$5,$5) ON CONFLICT(project_id,subject_id,role) DO UPDATE SET grant_event_id=$4,revoke_event_id=NULL,state='active',updated_at=$5`,[event.projectId,event.subjectId,event.role,event.operationId,at]);
      if(event.kind==='revoke-role')await db.query("UPDATE project_roles_v2 SET state='revoked',revoke_event_id=$4,updated_at=$5 WHERE project_id=$1 AND subject_id=$2 AND role=$3",[event.projectId,event.subjectId,event.role,event.operationId,at]);
      if(event.kind==='offer-transfer')await db.query(`INSERT INTO project_transfers_v2(id,project_id,from_subject_id,to_subject_id,state,offer_event_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,'offered',$5,$6,$6)`,[event.transferId,event.projectId,actor.subjectId,event.toSubjectId,event.operationId,at]);
      if(transfer) {
        await db.query('UPDATE project_transfers_v2 SET state=$2,response_event_id=$3,updated_at=$4 WHERE id=$1',[transfer.id,event.kind==='accept-transfer'?'accepted':'cancelled',event.operationId,at]);
        if(event.kind==='accept-transfer'){
          await db.query('UPDATE projects_v2 SET owner_id=$2,policy_event_id=$3 WHERE id=$1',[event.projectId,actor.subjectId,event.operationId]);
          await db.query("UPDATE project_roles_v2 SET state='revoked',revoke_event_id=$3,updated_at=$4 WHERE project_id=$1 AND subject_id=$2",[event.projectId,actor.subjectId,event.operationId,at]);
        }
      }
      if(['archive','restore'].includes(event.kind))await db.query('UPDATE projects_v2 SET state=$2 WHERE id=$1',[event.projectId,event.kind==='archive'?'archived':'active']);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:event.operationId,action:'project.event',httpRequestId:actor.httpRequestId??null,...authorization});
      return {operationId:event.operationId,projectId:event.projectId,revision,applied:true,replayed:false};
    },{write:true});
  }
  async preferenceWithin(db,actor,projectId) {
    const row=(await db.query('SELECT * FROM project_preferences_v2 WHERE project_id=$1 AND subject_id=$2',[projectId,actor.subjectId])).rows[0];
    return {projectId,revision:row?.revision??0,preferences:row?.settings?parse(discoveryPreferencesSchema,row.settings):null};
  }
  preferences(actor,projectId) {return this.run(actor,async db=>{await this.readWithin(db,actor,projectId);return this.preferenceWithin(db,actor,projectId);});}
  savePreferences(actor,projectId,input) {
    const request=parse(projectPreferenceV2Schema,input);
    return this.run(actor,async db=>{
      await this.readWithin(db,actor,projectId);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912359))',[projectId+':'+actor.subjectId]);
      const current=await this.preferenceWithin(db,actor,projectId);if(current.revision!==request.expectedRevision)fail('project_preference_conflict');
      await db.query(`INSERT INTO project_preferences_v2(project_id,subject_id,revision,settings,updated_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(project_id,subject_id) DO UPDATE SET revision=$3,settings=$4,updated_at=$5`,[projectId,actor.subjectId,current.revision+1,JSON.stringify(request.preferences),stamp(this.access.now())]);
      return this.preferenceWithin(db,actor,projectId);
    },{write:true});
  }
  async effectiveWishWithin(db,subjectId,projectId,{active=false,purposes=null}={}) {
    const stored=(await this.notifications.preferencesWithin(db,{subjectId})).settings.discovery;
    const local=(await this.preferenceWithin(db,{subjectId},projectId)).preferences;
    const base=stored??(active?{...defaultDiscoveryPreferences,enabled:true}:defaultDiscoveryPreferences);
    const long=effectiveDiscovery(base,this.access.now()),specific=local?effectiveDiscovery(local,this.access.now()):null;
    return {enabled:long.enabled&&(!specific||specific.enabled),purposes:purposes??specific?.purposes??long.purposes,
      functions:specific?.functions??long.functions,temporaryUntil:specific?.temporaryUntil??long.temporaryUntil};
  }
  sealDirectoryCursor(value) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.directoryCursorKey,iv);
    cipher.setAAD(Buffer.from('galaxy-project-directory-v2'));
    const body=Buffer.concat([cipher.update(JSON.stringify({...value,expiresAt:this.access.now()+directoryCursorSeconds})),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
  }
  openDirectoryCursor(value,queryHash,viewerId) {
    try {
      const bytes=Buffer.from(value,'base64url');
      if(bytes.toString('base64url')!==value||bytes.length<29)throw new Error();
      const cipher=createDecipheriv('aes-256-gcm',this.directoryCursorKey,bytes.subarray(0,12));
      cipher.setAAD(Buffer.from('galaxy-project-directory-v2'));cipher.setAuthTag(bytes.subarray(12,28));
      const cursor=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
      if(cursor.v!==2||cursor.queryHash!==queryHash||cursor.viewerId!==viewerId||cursor.expiresAt<=this.access.now())throw new Error();
      return cursor;
    } catch {fail('project_directory_cursor_unavailable_restart');}
  }
  async directoryItemWithin(db,projectId,options) {
    // A directory is public for every caller. Owner/editor rights and private
    // field sources must never enlarge its objects or summary, even when logged in.
    const view=await this.readWithin(db,null,projectId),row=await this.rowWithin(db,projectId);
    const latest=(await db.query('SELECT * FROM project_events_v2 WHERE operation_id=$1',[row.document_event_id])).rows[0];
    const grant=await this.grantWithin(db,latest);
    if(!canReadProjection(grant,{viewerId:null,projection:'history',now:this.access.now()})||!view.document.discoverable)return null;
    const document=Object.fromEntries(directoryFields.filter(field=>Object.hasOwn(view.document,field)).map(field=>[field,view.document[field]]));
    const item={projectId,ownerId:view.ownerId,document,classification:'self-declared',capabilityVerified:false,legalOwnershipVerified:false,
      source:{kind:'project',projectId,fieldSources:view.source.fieldSources.filter(source=>directoryFields.includes(source.field))}};
    // A public body of work remains readable when its author pauses contact.
    // Only the separate opportunity flow can express current contact willingness.
    if(options.portfolio)return item;
    const wish=await this.effectiveWishWithin(db,view.ownerId,projectId);
    if(!wish.enabled||options.purpose&&!wish.purposes.includes(options.purpose)||options.kind&&view.document.kind!==options.kind)return null;
    const publicFunctions=[...new Set(view.document.functions.map(normalizeFunction))].sort((left,right)=>left<right?-1:left>right?1:0);
    const allowedFunctions=wish.functions.length?publicFunctions.filter(value=>wish.functions.includes(value)):publicFunctions;
    if(!allowedFunctions.length)return null;
    if(options.query&&!normalizeFunction([view.document.title,view.document.summary,...view.document.functions].join('\n')).includes(options.query))return null;
    return {...item,
      discovery:{purposes:wish.purposes,functions:allowedFunctions,functionsRestricted:wish.functions.length>0,
        temporaryUntil:wish.temporaryUntil,contactRequiresCurrentCheck:true}};
  }
  publicDirectory(actor,input) {
    return this.publicCollection(actor,input,false);
  }
  publicPortfolio(actor,input) {
    return this.publicCollection(actor,input,true);
  }
  publicCollection(actor,input,portfolio) {
    const parsed=(portfolio?projectPortfolioQueryV2Schema:projectDirectoryQueryV2Schema).safeParse(input);
    if(!parsed.success)fail(portfolio?'invalid_project_portfolio_query':'invalid_project_directory_query',400);
    const options={...parsed.data,portfolio,query:normalizeFunction(parsed.data.query??'')},viewerId=actor?.subjectId??null;
    const queryHash=digest(canonicalize({query:options.query,kind:options.kind??null,purpose:options.purpose??null,limit:options.limit,
      ...(portfolio?{collection:'portfolio',ownerId:options.ownerId}:{})}));
    const cursor=options.after?this.openDirectoryCursor(options.after,queryHash,viewerId):null,startAfter=cursor?.startAfter??'';
    return this.run(actor,async db=>{
      // The raw scan is finite. Its position can include private objects, so only
      // the authenticated encrypted cursor carries it; no counts or ranks leak.
      const rows=(await db.query("SELECT id FROM projects_v2 WHERE state='active' AND ($1='' OR id::text>$1) AND ($3::text IS NULL OR owner_id=$3) ORDER BY id LIMIT $2",[startAfter,directoryWindowSize+1,portfolio?options.ownerId:null])).rows;
      const scanned=rows.slice(0,directoryWindowSize),visible=[];
      for(const row of scanned){try{const item=await this.directoryItemWithin(db,row.id,options);if(item)visible.push(item);}catch(error){if(!unavailable(error))throw error;}}
      const sourceHash=digest(canonicalize(visible));
      if(cursor?.lastKey&&(cursor.sourceHash!==sourceHash||!visible.some(item=>item.projectId===cursor.lastKey)))fail('project_directory_sources_changed_retry');
      const remaining=cursor?.lastKey?visible.filter(item=>item.projectId>cursor.lastKey):visible,items=remaining.slice(0,options.limit);
      let nextAfter=null;
      if(remaining.length>options.limit)nextAfter=this.sealDirectoryCursor({v:2,queryHash,viewerId,startAfter,lastKey:items.at(-1).projectId,sourceHash});
      else if(rows.length>directoryWindowSize)nextAfter=this.sealDirectoryCursor({v:2,queryHash,viewerId,startAfter:scanned.at(-1).id,lastKey:null,sourceHash:null});
      return {schemaVersion:2,items,nextAfter,computedAt:this.access.now(),readOnly:true,readingGrantsContact:false,readingGrantsMembership:false,
        coverage:{windowLimited:rows.length>directoryWindowSize,scanWindowLimit:directoryWindowSize,ordering:'project-id-within-window',
          currentPublicSources:true,globalCountProvided:false,globalRanking:false}};
    });
  }
}
