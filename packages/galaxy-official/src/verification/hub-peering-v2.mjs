import * as z from 'zod/v4';
import {verifyEnvelope} from '../signed-envelope.mjs';
import {ciProofV2Schema,describeCiProofV2} from '../shared/ci-observation-v2-schema.mjs';
import {contributionSourceRefSchema} from '../shared/contribution-sharing-v2-schema.mjs';
import {digest} from '../shared/digest.mjs';
import {ServiceError} from '../shared/service-error.mjs';
const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),time=z.int().nonnegative();
const base={grantId:id,state:z.literal('current'),sourceKey:z.string().min(1).max(300),issuer:z.url(),subjectId:subject,observedAt:time,
  expiresAt:time,synthetic:z.boolean(),capabilityVerified:z.literal(false)};
const summary=z.strictObject({eventType:z.string().min(1).max(100),actorId:subject,role:z.string().max(100).nullable().optional(),
  interventionTypes:z.array(z.string().min(1).max(100)).max(20).nullable().optional(),scopeVersion:z.int().positive().nullable().optional(),
  reportedOutcome:z.string().max(100).nullable().optional(),time:z.union([z.iso.datetime(),time]).nullable().optional()});
export const peerResponseSchema=z.strictObject({profile:z.literal('galaxy-direct-proof/1'),kind:z.literal('response'),queryId:id,requestHash:hash,
  agreementId:id,agreementHash:hash,origin:z.url(),destination:z.url(),fromHubId:id,toHubId:id,requesterId:subject,purpose:z.literal('help-discovery'),
  items:z.array(z.union([
    z.strictObject({grantId:id,state:z.literal('unavailable')}),
    z.strictObject({...base,sourceObject:z.strictObject({kind:z.literal('ci-proof-v2'),id,payloadHash:hash}),
      authority:z.literal('issuer-attested-github-api-observation'),signed:z.string().max(30000)}),
    z.strictObject({...base,sourceObject:contributionSourceRefSchema,authority:z.literal('author-selected-contribution-summary'),projection:summary,
      synthetic:z.boolean().nullable(),independentExecutionVerified:z.literal(false),originalTextAccessGranted:z.literal(false)})
  ])).max(40),nextCursor:time,hasMore:z.boolean(),deferredRecheck:z.array(id).max(20),checkedAt:time,expiresAt:time,
  coverage:z.literal('explicit-source-grants-for-exact-peer-and-reader'),route:z.literal('direct'),intermediaries:z.tuple([]),officialProtocolFee:z.literal(0),
  rawContextIncluded:z.literal(false),capabilityVerified:z.literal(false),independentSourcesAdded:z.literal(0),autonomousDomainVerified:z.literal(false),responseBodyPersisted:z.literal(false)});
export async function validatePeerResponse(input,{agreement,peer,now}){
  const p=peerResponseSchema.safeParse(input);if(!p.success)throw new ServiceError('peering_response_invalid',409);const value=p.data;
  if(value.items.length>agreement.pageSize+20||value.checkedAt>now||value.expiresAt<=now||value.expiresAt>value.checkedAt+agreement.responseMaxAgeSeconds
    ||new Set(value.items.map(i=>i.grantId)).size!==value.items.length)throw new ServiceError('peering_response_invalid',409);
  const groups=new Map();
  for(const item of value.items){if(item.state!=='current')continue;
    if(item.issuer!==peer.endpoint||item.observedAt>now||item.expiresAt<=now)throw new ServiceError('peering_source_invalid',409);
    if(item.sourceObject.kind==='ci-proof-v2'){
      if(!agreement.sourceKinds.includes('ci-proof-v2'))throw new ServiceError('peering_kind_not_agreed',409);
      const checked=await verifyEnvelope(item.signed,{type:'proof',issuer:peer.endpoint,audience:peer.endpoint,
        trustedKeys:new Map(peer.keys.map(k=>[k.kid,{...k,revoked:false}])),now,maxAge:86400});
      const data=ciProofV2Schema.parse(checked.data),provenance=describeCiProofV2(data);
      if(data.id!==item.sourceObject.id||digest(JSON.stringify(checked.data))!==item.sourceObject.payloadHash||data.subject!==item.subjectId
        ||data.synthetic!==item.synthetic||provenance.sourceKey!==item.sourceKey||data.observedAt!==item.observedAt||item.expiresAt>data.expiresAt)
        throw new ServiceError('peering_proof_mismatch',409);
      // This parsed projection is local. Keep the original signed bytes/data
      // intact, and never display them beyond their actual signature lifespan.
      item.expiresAt=Math.min(item.expiresAt,checked.expiresAt);
      const group=groups.get(item.sourceKey)??{sourceKey:item.sourceKey,records:0,commits:new Set(),conclusions:new Set()};
      group.records++;group.commits.add(data.source.commit);group.conclusions.add(data.conclusion);groups.set(item.sourceKey,group);
    }else{
      if(!agreement.sourceKinds.includes('contribution-summary')||item.projection.actorId!==item.subjectId
        ||item.sourceKey!==digest(JSON.stringify([peer.endpoint,item.sourceObject.kind,item.sourceObject.id,item.sourceObject.payloadHash])))
        throw new ServiceError('peering_summary_mismatch',409);
    }
  }
  // The peer's signed observation remains intact. Only the local display window
  // narrows to the earliest known current source or agreement deadline.
  const expiresAt=Math.min(value.expiresAt,agreement.expiresAt,...value.items.filter(item=>item.state==='current').map(item=>item.expiresAt));
  if(expiresAt<=now)throw new ServiceError('peering_response_expired',409);
  return{...value,expiresAt,sourceGroups:[...groups.values()].map(g=>({sourceKey:g.sourceKey,proofRecords:g.records,
    conflicts:[...(g.commits.size>1?['commit']:[]),...(g.conclusions.size>1?['conclusion']:[])],independentEvidenceAdded:0})),
    scopeMeaning:'Peer-authorized finite observations; no automatic result acceptance, resolution or capability certification'};
}
