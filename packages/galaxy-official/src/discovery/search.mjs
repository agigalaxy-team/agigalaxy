import { searchQuerySchema } from "../shared/search-schema.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { transaction } from "../infrastructure/database.mjs";

export class SearchService{
  constructor(access,{history,proofs,capsules,builders,index=null}){Object.assign(this,{access,history,proofs,capsules,builders,index});}
  async query(actor,input){
    const parsed=searchQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_search_query');
    const {type,query}=parsed.data;
    const candidates=!actor&&this.index?await this.index.candidates(type,{...query,subjectId:query.ownerId??query.authorId??query.subjectId,limit:200}):null;
    const result=await this.querySource(actor,type,query,candidates?.enabled?candidates.items.map(item=>item.id):null);
    if(candidates?.enabled)return {...result,index:{mode:'public-candidate-index',freshnessLimitSeconds:60,currentSourceChecked:true},
      windowLimited:result.windowLimited||candidates.truncated,nextCursor:result.nextCursor??(candidates.truncated?result.items.at(-1)?.id??null:null)};
    return result;
  }
  async querySource(actor,type,query,candidateIds){
    if(type==='worker'||type==='hub'){
      const page=await this.builders.query(actor,{...query,type},{publicOnly:true,candidateIds,sourceSearch:true});
      return this.page(type,page.items.map(item=>({type,id:item.builderId,title:item.name,summary:item.scope,
        source:{kind:type,id:item.builderId,ownerId:item.ownerId,declarationId:item.declarationId,declarationHash:item.declarationHash,revision:item.revision,version:item.version},
        record:item,matchReasons:item.matchReasons,limitations:['Registry owner declaration; not an active Worker or Hub connection.','Compatibility and heartbeat reports are separate from capability certification; endpoint reachability is not established.']})),page.nextAfter,page.windowLimited);
    }
    if(type==='proof')return actor?this.access.runAuthorized(actor,'proof',db=>this.proofQuery(db,actor,query,candidateIds)):transaction(this.access.db,db=>this.proofQuery(db,null,query,candidateIds));
    if(type==='capsule'){
      const page=await this.capsules.query(actor,query,{candidateIds});
      return this.page(type,page.items.map(item=>({type,id:item.capsuleId,title:item.title,summary:item.capabilityId,
        source:{kind:'capsule',id:item.capsuleId,versionId:item.versionId,version:item.version},record:item,
        matchReasons:[`title/problem contains: ${query.query||'(no text filter)'}`,...(query.capabilityId?[`author-declared capability: ${query.capabilityId}`]:[])],
        limitations:['Author-published reusable method; applicability and current notices must be checked.']})),page.nextAfter,Boolean(page.windowLimited));
    }
    const page=await this.history.query(actor,query,{candidateIds});
    return this.page(type,page.items.map(item=>({type,id:item.caseId,title:item.title,summary:item.summary,
      source:{kind:type,id:item.caseId,sourceVersion:item.sourceVersion,projectionRule:item.rebuild?.rule??null},record:item,
      matchReasons:item.matchReasons,limitations:item.searchExplanation?.limitations??['Owner-reported Case facts; not individual capability certification.']})),page.nextCursor,Boolean(page.search?.windowLimited));
  }
  page(type,items,nextCursor,windowLimited){return {version:1,type,items,nextCursor,windowLimited,
    checkedAt:this.access.now(),order:'source-id',countsScope:'visible-page-only',pageCount:items.length,
    capabilityVerified:false,cacheable:false,endpoint:this.access.endpoint};}
  async proofQuery(db,actor,query,candidateIds=null){
    const now=this.access.now(),viewer=actor?.subjectId??null;
    // Grant visibility precedes the scan limit. Each candidate is still read
    // through ProofService, including its current source and signature checks.
    const rows=(await db.query(`SELECT p.id,p.payload_text FROM proofs p JOIN consents c ON c.id=p.consent_id JOIN bindings b ON b.id=c.binding_id
      WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::text IS NULL OR p.subject_id=$2)
        AND ($6::uuid[] IS NULL OR p.id=ANY($6))
        AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$4 AND b.expires_at>$4
        AND c.subject_id=p.subject_id AND b.subject_id=p.subject_id AND c.intent->>'recipient'=$5
        AND c.intent->>'action'='proof.publish' AND c.intent->>'objectId'=p.id::text AND c.intent->>'payloadHash'=p.payload_hash
        AND (p.subject_id=$3 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
          OR c.intent->>'visibility' IN ('Private','Proof-only') AND c.intent->'viewers' ? COALESCE($3,''))
      ORDER BY p.id LIMIT 201`,[query.after??null,query.subjectId??null,viewer,new Date(now*1000).toISOString(),this.access.endpoint,candidateIds])).rows;
    const items=[],terms=[...new Set(query.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean))];let lastVisible=null;
    for(const row of rows.slice(0,200)){
      try{
        const current=await this.proofs.readWithin(db,actor,row.id),payload=JSON.parse(row.payload_text);lastVisible=row.id;
        const fields={repository:`${payload.source.owner}/${payload.source.repository}`,commit:payload.source.commit,
          runId:String(payload.source.runId),conclusion:payload.conclusion,scope:payload.scope};
        const matches=terms.map(term=>({term,fields:Object.keys(fields).filter(key=>String(fields[key]).toLocaleLowerCase('en-US').includes(term))}));
        if(matches.some(match=>!match.fields.length)||query.conclusion&&query.conclusion!==payload.conclusion)continue;
        items.push({type:'proof',id:row.id,title:`${fields.repository} · run ${fields.runId}`,summary:payload.conclusion,
          source:{kind:'proof',id:row.id,evidenceId:payload.evidenceId,observationId:payload.observationId,reference:payload.source},
          record:{...current,assertion:payload},matchReasons:matches.length?matches.map(match=>`${match.term} → ${match.fields.join(', ')}`):['current visible Proof, source ID order'],
          limitations:payload.limitations,capabilityVerified:false});
        if(items.length>query.limit)break;
      }catch(error){if(!(error instanceof ServiceError))throw error;}
    }
    const page=items.slice(0,query.limit),windowLimited=items.length<=query.limit&&rows.length>200;
    // Never expose a cursor naming an unavailable Proof. If every candidate
    // failed its current read, the caller must narrow this bounded query.
    return this.page('proof',page,items.length>query.limit?page.at(-1).id:windowLimited?lastVisible:null,windowLimited);
  }
}
