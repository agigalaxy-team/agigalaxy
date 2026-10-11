import * as z from 'zod/v4';

const uuid=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive();
export const taskMaterialLimits=Object.freeze({materials:8,segments:8,bodyBytes:49152,envelopeBytes:100000,legacyEnvelopeBytes:32768});
export const taskMaterialSourceSchema=z.strictObject({kind:z.literal('forum-post-version'),endpoint:z.url(),postId:uuid,versionId:uuid,
 permissionId:uuid,payloadHash:hash,field:z.enum(['title','body']),start:z.number().int().nonnegative(),end:positive,selectionHash:hash}).refine(v=>v.end>v.start);
export const taskMaterialDescriptorSchema=z.strictObject({materialId:uuid,source:taskMaterialSourceSchema,textHash:hash,purpose:z.literal('task-context'),expiresAt:positive});
export const taskTextSegmentSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('literal'),text:z.string().min(1).max(10000)}),
 z.strictObject({kind:z.literal('material'),materialId:uuid}),
]);
export function taskTextSchema(maximum,{single=false}={}){
 return z.union([z.string().trim().min(1).max(maximum),z.strictObject({format:z.literal('task-text-v1'),segments:z.array(taskTextSegmentSchema).min(1).max(single?1:taskMaterialLimits.segments)})])
  .refine(value=>typeof value==='string'||value.segments.some(s=>s.kind==='material')||!!value.segments.map(s=>s.text).join('').trim()&&value.segments.map(s=>s.text).join('').length<=maximum);
}
export const taskMaterialBodySchema=z.strictObject({materialId:uuid,text:z.string().min(1).max(10000)});
export const taskMaterialPrepareSchema=z.strictObject({source:z.strictObject({postId:uuid,versionId:uuid}),selections:z.array(z.strictObject({materialId:uuid,
 field:z.enum(['title','body']),start:z.number().int().nonnegative(),end:positive,text:z.string().min(1).max(10000).optional()}).refine(v=>v.end>v.start)).min(1).max(taskMaterialLimits.materials),expiresAt:positive})
 .refine(v=>new Set(v.selections.map(s=>s.materialId)).size===v.selections.length);
export const taskMaterialPrepareResultSchema=z.strictObject({descriptors:z.array(taskMaterialDescriptorSchema).min(1).max(taskMaterialLimits.materials),
 materialBodies:z.array(taskMaterialBodySchema).min(1).max(taskMaterialLimits.materials),checkedAt:z.number().int().nonnegative(),
 source:z.strictObject({kind:z.literal('forum-post-version'),endpoint:z.url(),postId:uuid,versionId:uuid,permissionId:uuid,payloadHash:hash}),sourceAvailableUntil:positive});
export const taskMaterialSubmissionSchema=z.strictObject({signedIntent:z.string().min(1).max(16384),payloadJson:z.string().min(1).max(24000),
 materialBodies:z.array(taskMaterialBodySchema).min(1).max(taskMaterialLimits.materials)});
export const legacyTaskSubmissionSchema=z.strictObject({consentId:uuid,payloadJson:z.string().min(1).max(24000)});
export const taskCreationSubmissionSchema=z.union([legacyTaskSubmissionSchema,taskMaterialSubmissionSchema]);
export function taskTextMaterialIds(value){return typeof value==='string'?[]:(value?.segments??[]).filter(s=>s.kind==='material').map(s=>s.materialId);}
export function taskTextFields(request){return {title:request.title,summary:request.summary,goal:request.workContext.goal,currentSituation:request.workContext.currentSituation,
 ...(request.expectedOutcome===undefined?{}:{expectedOutcome:request.expectedOutcome})};}
export function taskMaterialReferenceIssue(request){
 const descriptors=request.materials??[],ids=descriptors.map(d=>d.materialId),refs=Object.values(taskTextFields(request)).flatMap(taskTextMaterialIds);
 if(new Set(ids).size!==ids.length||ids.some(id=>!refs.includes(id))||refs.some(id=>!ids.includes(id)))return 'Task material descriptors must match every referenced material exactly.';
 return null;
}
export const hasTaskMaterials=request=>(request.materials?.length??0)>0;
export const hasTaskText=request=>Object.values(taskTextFields(request)).some(value=>typeof value!=='string');
export function taskMaterialBodyBytes(bodies){return bodies.reduce((n,b)=>n+new TextEncoder().encode(b.text).length,0);}
export function taskMaterialBodyIssue(request,bodies){
 const descriptors=request.materials??[],ids=bodies.map(b=>b.materialId);
 if(descriptors.length!==ids.length||new Set(ids).size!==ids.length||descriptors.some(d=>!ids.includes(d.materialId)))return 'Task material bodies must match the original descriptors exactly.';
 if(taskMaterialBodyBytes(bodies)>taskMaterialLimits.bodyBytes)return 'Task material body byte limit exceeded.';
 return null;
}
