// A local copy, never publication or private-cloud synchronization.
export function createVisitorDraftAdoption({store,prefix,getActive}){
 const previews=new WeakMap();
 async function preview(){const active=await getActive();if(!active)return null;
  const sourceKey=prefix+'visitor:task-draft',targetKey=prefix+active.subjectId+':task-draft';
  const [source,target]=await Promise.all([store.get(sourceKey),store.get(targetKey)]);if(!source)return null;
  const result=structuredClone({subjectId:active.subjectId,visitorDraft:source,existingDraft:target??null,sourceRetained:true});
  previews.set(result,{subjectId:active.subjectId,sourceKey,targetKey,expectedSource:structuredClone(source),expectedTarget:structuredClone(target??null)});return result;
 }
 async function adopt(value,{confirmed=false}={}){const record=previews.get(value),active=await getActive();
  if(!confirmed||!record||active?.subjectId!==record.subjectId)throw new Error('Confirm adopting this visitor draft for the current identity.');
  if(typeof store.copyConfirmedDraft!=='function')throw new Error('Atomic local draft adoption is unavailable in this storage adapter.');
  const result=await store.copyConfirmedDraft({...record,confirmed:true});
  if((await getActive())?.subjectId!==record.subjectId)return {...result,subjectId:record.subjectId,currentIdentityChanged:true};
  previews.delete(value);return {...result,subjectId:record.subjectId,currentIdentityChanged:false};
 }
 return Object.freeze({preview,adopt});
}
