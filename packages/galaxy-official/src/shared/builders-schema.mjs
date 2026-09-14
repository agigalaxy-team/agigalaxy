import * as z from 'zod/v4';
const text = max => z.string().trim().min(1).max(max);
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = values => new Set(values).size === values.length;
// These are references, never fetch instructions. No credentials or URL query payloads.
const reference = z.url().max(500).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
export const builderAssessorIdsSchema = z.array(subject).max(8).refine(unique);
const release = z.strictObject({version:text(80), buildHash:hash, sourceCommit:z.string().regex(/^[a-f0-9]{40,64}$/),
  artifact:reference, dependencies:z.array(z.strictObject({name:text(100),version:text(80),sha256:hash})).max(32),
  upgrade:text(1500), rollback:text(1500)});
const common = {name:text(160), release, policy:reference, contact:reference, scope:text(1500), redactionConfirmed:z.literal(true),
  proofIds:z.array(z.uuid()).max(16).refine(unique)};
const a2aTarget=z.strictObject({protocol:z.literal('a2a/1.0'),transport:z.literal('JSONRPC'),endpoint:reference,cardUrl:reference,tenant:z.string().max(256)});
export const builderDeclarationSchema = z.discriminatedUnion('type', [
  z.strictObject({...common,type:z.literal('worker'),nodeId:subject,
    a2a:a2aTarget.optional(),
    configuration:z.strictObject({id:text(100),summary:text(1500),modelFamily:text(100),tools:z.array(text(100)).max(32),
      taskTypes:z.array(text(100)).min(1).max(16),maxConcurrentTasks:z.number().int().min(1).max(1000)}),
    capabilities:z.array(z.strictObject({id:text(100),claim:text(1000),limitations:text(1000)})).min(1).max(16)}),
  z.strictObject({...common,type:z.literal('bridge'),mapping:z.strictObject({sourceSystem:text(160),sourceObjects:z.array(text(100)).min(1).max(16),
    targetObjects:z.array(text(100)).min(1).max(16),rules:text(3000),strengthCeiling:z.enum(['source-assertion','execution-observation']),
    authorization:text(1000),version:text(80),deduplication:text(1500),revocation:text(1500),provenance:text(1500)})}),
  z.strictObject({...common,type:z.literal('hub'),operator:text(160),charter:reference,region:text(160),endpoint:reference,
    manifest:z.strictObject({url:reference,sha256:hash,specVersion:text(80)}),exit:text(1500),export:text(1500)})
]);
const event = {id:z.uuid(),builderId:z.uuid(),expectedRevision:z.number().int().min(0).max(9999)};
export const legacyConformanceChecks = Object.freeze(['ids','schema','signatures','import','privacy','revocation']);
export const conformanceChecks = Object.freeze(['ids','evidence','signatures','schema','import','privacy','revocation']);
export const builderEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({...event,kind:z.literal('declare'),declaration:builderDeclarationSchema}),
  z.strictObject({...event,kind:z.literal('maintenance'),declarationId:z.uuid(),
    action:z.enum(['delist','relist','correction','security-issue','resolve-security']),summary:text(2000)}),
  z.strictObject({...event,kind:z.literal('heartbeat'),declarationId:z.uuid()}),
  z.strictObject({...event,kind:z.literal('node-control'),declarationId:z.uuid(),declarationHash:hash,
    ownerId:subject,nodeId:subject,expiresAt:z.number().int().positive()}),
  z.strictObject({...event,kind:z.literal('node-control-revoke'),declarationId:z.uuid(),controlId:z.uuid(),reason:text(1000)}),
  z.strictObject({...event,kind:z.literal('probe-request'),declarationId:z.uuid(),declarationHash:hash,controlId:z.uuid(),nodeId:subject,target:a2aTarget}),
  z.strictObject({...event,kind:z.literal('work-evidence'),declarationId:z.uuid(),declarationHash:hash,controlId:z.uuid(),nodeId:subject,
    caseId:z.uuid(),attemptId:z.uuid(),resultId:z.uuid(),proofIds:z.array(z.uuid()).min(1).max(8).refine(unique),summary:text(1500),
    task:z.strictObject({protocol:z.literal('a2a/1.0'),endpoint:reference,taskId:text(128),contextId:text(128).optional()}).optional()}),
  z.strictObject({...event,kind:z.literal('work-evidence-revoke'),declarationId:z.uuid(),workEventId:z.uuid(),reason:text(1000)}),
  z.strictObject({...event,kind:z.literal('compatibility'),declarationId:z.uuid(),declarationHash:hash,
    profile:z.literal('galaxy-conformance/2').optional(),
    execution:z.strictObject({kind:z.literal('local-source-tests'),sourceHash:hash,runHash:hash,runnerVersion:text(80),runtime:text(160)}).optional(),
    suite:z.strictObject({name:text(100),version:text(80),sha256:hash,source:reference}),
    observedAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive(),
    checks:z.array(z.strictObject({id:z.enum(conformanceChecks),status:z.enum(['pass','fail','not-tested']),detail:text(1000)}))
      .min(legacyConformanceChecks.length).max(conformanceChecks.length).refine(checks=>unique(checks.map(check=>check.id))),
    limitations:text(1500)}).refine(report=>{
      const required=report.profile?conformanceChecks:legacyConformanceChecks;
      return report.checks.length===required.length&&required.every(id=>report.checks.some(check=>check.id===id))&&(!report.execution||!!report.profile);
    })
]);
export const builderReadSchema = z.strictObject({builderId:z.uuid()});
export const builderOwnedQuerySchema=z.strictObject({type:z.enum(['worker','bridge','hub']).optional(),after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)});
export const builderReceiptSchema=z.strictObject({builderId:z.uuid(),eventId:z.uuid(),payloadHash:hash});
export const builderNoticesSchema=z.strictObject({builderId:z.uuid(),after:z.number().int().min(0).max(1000).default(0),limit:z.number().int().min(1).max(20).default(8)});
export const builderRecoveryActions=Object.freeze(['delist','correction','security-issue']);
export const builderQuerySchema = z.strictObject({type:z.enum(['worker','bridge','hub']).optional(),ownerId:subject.optional(),
  query:z.string().trim().max(200).default(''),after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)});

// Only fields from the current published declaration enter unified text search.
export function builderSearchFields(declaration){
  const fields={name:declaration.name,scope:declaration.scope,version:declaration.release.version};
  if(declaration.type==='worker')Object.assign(fields,{configuration:declaration.configuration.summary,modelFamily:declaration.configuration.modelFamily,
    tools:declaration.configuration.tools.join(' '),taskTypes:declaration.configuration.taskTypes.join(' '),
    capabilities:declaration.capabilities.map(item=>`${item.id} ${item.claim} ${item.limitations}`).join(' ')});
  if(declaration.type==='hub')Object.assign(fields,{operator:declaration.operator,region:declaration.region,endpoint:declaration.endpoint,specVersion:declaration.manifest.specVersion});
  return fields;
}
