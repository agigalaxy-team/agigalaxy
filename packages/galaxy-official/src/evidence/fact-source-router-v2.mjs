import {ServiceError} from "../shared/service-error.mjs";
export function createFactSourceRouter({verificationRecords,configurations,chat,outcomeMaterials}){
 return {requireReferenceWithin(db,actor,ref,context={}){
   if(['evidence','verification'].includes(ref.kind))return verificationRecords.requireReferenceWithin(db,actor,ref,context);
   if(ref.kind==='configuration')return configurations.requireReferenceWithin(db,actor,ref);
   if(ref.kind==='selected-message')return chat.readSelectedWithin(db,actor,{messageId:ref.id,revision:ref.version});
   if(ref.kind==='outcome-material'){
    if(!outcomeMaterials)throw new ServiceError('source_adapter_unavailable',503);
    return outcomeMaterials.readWithin(db,actor,ref.id).then(value=>{
      if(context.caseId&&value.caseId!==context.caseId)throw new ServiceError('source_case_mismatch',422);
      return { ...value, type:'outcome-material', contentHash:value.sha256, sourceState:value.state, authorId:value.authorId };
    });
   }
   throw new ServiceError('source_adapter_unavailable',503);
 }};
}
