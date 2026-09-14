import * as z from 'zod/v4';
// Existing control schema, shared between Node and offline WebCrypto validation.
export function controlSchemas({controlSubject,controlPublicKey}){
const scopes=z.array(z.string().regex(/^[a-z][a-z0-9:-]{0,63}$|^\*$/)).min(1).max(64)
  .refine(value=>new Set(value).size===value.length);
const controlDeviceSchema=z.strictObject({deviceId:z.uuid(),publicKeyPem:controlPublicKey,scopes});
const base={version:z.literal(2).default(2),operationId:z.uuid(),subjectId:controlSubject,
  expectedEpoch:z.number().int().min(0),previousEventHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  signerKeyId:z.string().regex(/^[a-f0-9]{64}$/)};
const controlOperationSchema=z.discriminatedUnion('kind',[
  z.strictObject({...base,kind:z.literal('bootstrap'),genesisProof:z.unknown(),newDevice:controlDeviceSchema}),
  z.strictObject({...base,kind:z.literal('authorize-device'),newDevice:controlDeviceSchema}),
  z.strictObject({...base,kind:z.literal('revoke-device'),deviceId:z.uuid()}),
  z.strictObject({...base,kind:z.literal('set-recovery'),recoveryGeneration:z.number().int().min(0),nextRecoveryPublicKey:controlPublicKey,saveDeclaration:z.literal(true)}),
  z.strictObject({...base,kind:z.literal('recover'),recoveryGeneration:z.number().int().min(1),newDevice:controlDeviceSchema,nextRecoveryPublicKey:controlPublicKey}),
  z.strictObject({...base,kind:z.literal('declare-recovery-saved'),recoveryGeneration:z.number().int().min(1),saveDeclaration:z.literal(true)}),
]);
const controlCommitSchema=z.strictObject({operationId:z.uuid(),controllerSignature:z.string().min(1).max(24000),newDeviceProof:z.string().min(1).max(24000).optional()});

return {controlDeviceSchema,controlOperationSchema,controlCommitSchema};
}
