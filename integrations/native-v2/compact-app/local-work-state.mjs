const formForAction={galaxy_local_panel_settings_save:'settings',galaxy_local_panel_work_sync_save:'work'};
const copy=value=>value===undefined?undefined:structuredClone(value);

// Private reading and unfinished choices stay in this mounted panel only.
// A response for another local identity discards both before it is rendered.
export function createLocalPanelMemory(){
  let owner=null;const pages=new Map(),drafts=new Map(),listPositions=new Map();
  return {
    useIdentity(galaxyId){if(owner!==galaxyId){pages.clear();drafts.clear();listPositions.clear();owner=galaxyId;}},
    remember(page,position={}){this.useIdentity(page.galaxyId);pages.set(page.view,{page,position});if(!page.selectedWork&&!page.selectedArchive)listPositions.set(page.view,position);},
    page(view){return pages.get(view)?.page;},
    position(view){return pages.get(view)?.position;},
    listPosition(view){return listPositions.get(view);},
    draft(key){return copy(drafts.get(key));},
    edit(key,value,original){if(JSON.stringify(value)===JSON.stringify(original))drafts.delete(key);else drafts.set(key,copy(value));},
    completed(action){const key=formForAction[action];if(key)drafts.delete(key);},
    clear(){pages.clear();drafts.clear();listPositions.clear();owner=null;},
  };
}

const combine=(earlier,later,key)=>[...new Map([...earlier,...later].map(item=>[item[key],item])).values()];
export function mergeLocalWorkPage(current,next,{append=false,appendList=false,retainDetails=false}={}){
  if(!current||current.galaxyId!==next.galaxyId||current.view!==next.view)return next;
  const merged={...next};
  if(appendList){
    if(next.work)merged.work={...next.work,items:combine(current.work?.items??[],next.work.items,'workId')};
    if(next.archives)merged.archives={...next.archives,items:combine(current.archives?.items??[],next.archives.items,'archiveSessionId')};
    for(const key of ['selectedWork','relatedArchiveSessionId','selectedArchive','archiveTitle'])if(current[key]!==undefined)merged[key]=current[key];
  }else{
    if(next.selectedWork&&current.work)merged.work={...current.work,items:combine(current.work.items,next.work.items,'workId')};
    if(next.selectedArchive&&current.archives)merged.archives={...current.archives,items:combine(current.archives.items,next.archives.items,'archiveSessionId')};
    if(append&&next.selectedWork&&current.selectedWork?.work.workId===next.selectedWork.work.workId)merged.selectedWork={...next.selectedWork,observations:combine(current.selectedWork.observations,next.selectedWork.observations,'sequence')};
    if(append&&next.selectedArchive&&current.selectedArchive?.session.archiveSessionId===next.selectedArchive.session.archiveSessionId)merged.selectedArchive={...next.selectedArchive,messages:combine(current.selectedArchive.messages,next.selectedArchive.messages,'sequence')};
    if(retainDetails&&next.selectedWork&&current.selectedWork?.work.workId===next.selectedWork.work.workId&&Number.isSafeInteger(next.selectedWork.work.lastSequence)&&current.selectedWork.work.lastSequence===next.selectedWork.work.lastSequence)
      merged.selectedWork={...next.selectedWork,observations:combine(current.selectedWork.observations,next.selectedWork.observations,'sequence'),nextAfter:current.selectedWork.nextAfter};
    if(retainDetails&&next.selectedArchive&&current.selectedArchive?.session.archiveSessionId===next.selectedArchive.session.archiveSessionId&&Number.isSafeInteger(next.selectedArchive.session.revision)&&current.selectedArchive.session.revision===next.selectedArchive.session.revision)
      merged.selectedArchive={...next.selectedArchive,messages:combine(current.selectedArchive.messages,next.selectedArchive.messages,'sequence'),nextAfter:current.selectedArchive.nextAfter};
  }
  return merged;
}
