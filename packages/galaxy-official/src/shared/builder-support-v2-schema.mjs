import * as z from 'zod/v4';
const text = max => z.string().trim().min(1).max(max);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = items => new Set(items).size === items.length;
export const builderReferenceV2 = z.url().max(500).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
export const builderActionIds = Object.freeze([
  'identity.reference','case.read','case.write','attempt.read','attempt.write','attempt.map',
  'intervention.read','intervention.write','result.read','result.write','result.map',
  'evidence.read','evidence.write','evidence.import','verification.read','verification.write',
  'proof.read','proof.export','history.read','history.export','configuration.read','configuration.write',
  'consent.revoke','task.read','task.apply','worker.execute','hub.core','peering.query'
]);
const actions = z.array(z.enum(builderActionIds)).max(builderActionIds.length).refine(unique);
const version = z.strictObject({name:text(100),version:text(80)});
export const builderSupportProfileSchema = z.strictObject({
  profile:z.literal('galaxy-builder-support/2'),implementation:version,
  galaxySchema:text(100),protocols:z.array(version).max(16),sdks:z.array(version).max(16),
  objectActions:actions.refine(items=>items.length>0),missingCapabilities:actions,
  authorization:text(1500),limitations:text(2000),
  mapping:z.strictObject({version:text(80),sourceSystem:text(160),sourceObjects:z.array(text(100)).min(1).max(16),
    fields:z.array(z.strictObject({source:text(160),target:text(160),meaning:z.enum(['source-fact','source-claim','derived','unknown']),rule:text(1000)})).min(1).max(32),
    strengthCeiling:z.enum(['source-assertion','execution-observation']),sourceIdentity:text(1500),deduplication:text(1500),
    observationTime:text(1000),authorization:text(1000),revocation:text(1500),excludedData:text(1500)}).optional()
}).refine(value=>!value.objectActions.some(id=>value.missingCapabilities.includes(id)));
const dependency=z.strictObject({kind:z.enum(['skill','mcp','tool','runtime','model-interface']),name:text(100),
  version:text(80),source:builderReferenceV2,license:text(160),sha256:hash.optional()});
export const workerPackManifestSchema=z.strictObject({
  profile:z.literal('galaxy-worker-pack/1'),name:text(160),version:text(80),
  source:builderReferenceV2,sha256:hash,license:text(160),licenseSource:builderReferenceV2,
  dependencies:z.array(dependency).max(32),modelRequirements:text(1500),environment:text(1500),
  permissions:z.array(z.strictObject({resource:text(160),purpose:text(500),required:z.boolean()})).max(32),
  configurationRequirements:text(2000),capabilities:z.array(text(500)).min(1).max(16),
  changes:text(2000),installation:text(2000),upgrade:text(2000),rollback:text(2000),
  runtimeLocation:z.literal('user-controlled'),automaticActivation:z.literal(false)
});
const common={id:z.uuid(),builderId:z.uuid(),expectedRevision:z.number().int().min(1).max(999),
  declarationId:z.uuid(),declarationHash:hash};
export const builderExtensionEventSchema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('support-profile'),support:builderSupportProfileSchema}),
  z.strictObject({...common,kind:z.literal('pack-manifest'),manifest:workerPackManifestSchema}),
  z.strictObject({...common,kind:z.literal('scope-report'),profile:z.literal('galaxy-builder-scope-report/1'),
    supportId:z.uuid(),supportHash:hash,suite:z.strictObject({name:text(100),version:text(80),sha256:hash,source:builderReferenceV2}),
    run:z.strictObject({id:text(160),sourceHash:hash,reportHash:hash,runnerVersion:text(80),
      environment:text(1500),testClass:z.enum(['format','source-flow','independent-interop','host-experience']),
      peer:version.optional()}),
    checks:z.array(z.strictObject({action:z.enum(builderActionIds),status:z.enum(['pass','fail','not-tested']),detail:text(1000)}))
      .min(1).max(builderActionIds.length).refine(items=>unique(items.map(item=>item.action))),
    observedAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive(),limitations:text(2000)})
]);
export const builderExtensionReadSchema=z.strictObject({builderId:z.uuid()});
export const builderPackExportSchema=z.strictObject({builderId:z.uuid(),manifestId:z.uuid()});
export const builderExtensionWriteSchema=z.strictObject({consentId:z.uuid(),payloadJson:z.string().max(28000)});
