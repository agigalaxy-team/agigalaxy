type PageEnvironment={locks:Pick<LockManager,'request'>|null;storage:Pick<Storage,'getItem'|'setItem'>};

/** sessionStorage survives refresh, but an opener can copy it into another tab. */
export function createChatComposePageId({locks,storage}:PageEnvironment){
 let pageIdentity:Promise<string>|null=null;
 return function pageId():Promise<string>{
 if(pageIdentity)return pageIdentity;
 pageIdentity=new Promise<string>((resolve,reject)=>{
  if(!locks){reject(Error('这个浏览器暂时无法保护多页草稿，请更新浏览器后继续。'));return;}
  let saved:string|null;
  try{saved=storage.getItem('galaxy-chat-page');}catch{reject(Error('本机暂时无法读取草稿位置，请重新打开后再试。'));return;}
  const hold=new Promise<void>(()=>{});
  const claim=(id:string)=>{
   void locks.request('galaxy-chat-page:'+id,{ifAvailable:true},lock=>{
    if(!lock){claim(crypto.randomUUID());return;}
    try{storage.setItem('galaxy-chat-page',id);}catch{reject(Error('本机暂时无法保存草稿位置，请重新打开后再试。'));return;}
    resolve(id);
    // Keep ownership for this document, including SPA navigation and remounts.
    // The browser releases the lock when the document is discarded or reloaded.
    return hold;
   }).catch(()=>reject(Error('本机暂时无法保护这页草稿，请重新打开后再试。')));
  };
  claim(saved&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)?saved:crypto.randomUUID());
 });
 void pageIdentity.catch(()=>{});
 return pageIdentity;
 };
}

let documentPage:ReturnType<typeof createChatComposePageId>|null=null;
export function chatComposePageId():Promise<string>{
 documentPage??=createChatComposePageId({locks:navigator.locks??null,storage:{getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value)}});
 return documentPage();
}
