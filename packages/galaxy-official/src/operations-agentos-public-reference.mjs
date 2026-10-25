import {z} from 'zod';
import {ServiceError} from './shared/service-error.mjs';

// This is private transport metadata, produced from the current user's link.
// It is a source restriction, never permission, a model CAS or a network URL.
export const conversationPublicReferenceSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('post'),id:z.uuid(),versionId:z.uuid().optional()}),
 z.strictObject({kind:z.literal('reply'),id:z.uuid()})
]);
export function checkConversationPublicReference(reference,kind,id,current){
 if(reference===undefined)return;
 const parsed=conversationPublicReferenceSchema.safeParse(reference);
 if(!parsed.success||parsed.data.kind!==kind||parsed.data.id!==id)throw new ServiceError('invalid_operations_agentos_request',400);
 if(parsed.data.versionId!==undefined&&current?.versionId!==parsed.data.versionId)throw new ServiceError('operations_agentos_source_changed',409);
}
