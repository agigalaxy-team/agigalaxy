import {fail} from './helpers.mjs';

// Current authorization and persisted query/configuration state. The original public reader still decides source eligibility.
export class SearchQualityState{
 constructor({db,endpoint,permissions,businessAdmin,meili=null,openpanel=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,permissions,businessAdmin,meili,openpanel,now});this.reconciling=new Map();}
 metadata(){return {checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 async authorize(actor,action,db){if(!this.permissions)fail('operations_authorization_unavailable',503);return this.permissions.requireAction(actor,action,db?{db}:{});}
 async currentActor(operator,action,authorize,db){if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);const actor=await authorize();if(actor?.kind!=='business-operator'&&!this.businessAdmin?.executorAuthority?.acceptsDuty(actor)||actor.endpoint!==this.endpoint||actor.operatorId!==operator.operatorId)fail('business_admin_denied',403);return this.authorize(actor,action,db);}
 async stateWithin(db){return (await db.query('SELECT * FROM operations_search_quality_state_v1 WHERE endpoint=$1',[this.endpoint])).rows[0]??{revision:0,active_id:null,draft_id:null,pending_operation:null};}
 async versionWithin(db,id){if(!id)return null;return (await db.query("SELECT v.*,EXISTS(SELECT 1 FROM operations_search_quality_operations_v1 o WHERE o.endpoint=v.endpoint AND o.version_id=v.id AND o.kind IN ('apply','restore') AND o.phase='applied') AS was_applied FROM operations_search_quality_versions_v1 v WHERE v.endpoint=$1 AND v.id=$2",[this.endpoint,id])).rows[0]??null;}
 async operationWithin(db,id){return (await db.query('SELECT * FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0]??null;}
 async observedSettings(){if(!this.meili)fail('discovery_search_not_connected',503);return this.meili.settings();}
 async lock(db){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912430))',[this.endpoint]);}
}
