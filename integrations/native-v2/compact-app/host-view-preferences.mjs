// Stores only an explicitly selected, host-confirmed display mode. Host names
// come from SDK initialization; subjects/endpoints never come from iframe input.
export function mountHostViewPreferences(app,root){
 const status=root.ownerDocument.createElement('p');status.setAttribute('role','status');status.className='galaxy-host-view-status';root.before(status);
 let scope=null,epoch=0,revision=null,closed=false,loading=null,busy=false;
 const host=()=>app.getHostVersion()?.name;
 const valid=(stamp,name)=>!closed&&stamp===epoch&&host()===name;
 const note=(stamp,name,message)=>{if(valid(stamp,name))status.textContent=message;};
 async function call(action,args,stamp,name){
  if(!valid(stamp,name)||!scope)throw Error('host_view_owner_changed');
  const result=await app.callServerTool({name:'galaxy_host_view_state',arguments:{action,hostName:name,ownerScope:scope,...args}});
  if(!valid(stamp,name))throw Error('host_view_owner_changed');
  const data=result.structuredContent;if(result.isError)throw Error(data?.error??'host_view_unavailable');
  if(data?.kind!=='galaxy-host-view-state'||data.ownerScope!==scope||data.hostName!==name)throw Error('host_view_owner_changed');return data;
 }
 async function read(stamp,name){
  try{const data=await call('read',{},stamp,name);revision=data.revision;
   if(!data.mode){note(stamp,name,'');return;}
   if(!app.getHostContext()?.availableDisplayModes?.includes(data.mode)){note(stamp,name,'');return;}
   if(app.getHostContext()?.displayMode!==data.mode){const answer=await app.requestDisplayMode({mode:data.mode});if(!valid(stamp,name))return;
    if(answer.mode!==data.mode){note(stamp,name,'');return;}}
   note(stamp,name,'');
  }catch{note(stamp,name,'');}
 }
 function receive(result){const next=result?.isError?null:(result?.structuredContent??result)?.ownerScope??null;
  if(next===scope)return;scope=next;epoch++;revision=null;busy=false;loading=null;
  const name=host();if(!scope||!name){status.textContent='';return;}
  loading=read(epoch,name);
 }
 async function toggle(){const stamp=epoch,name=host();if(busy)return;busy=true;
  try{if(loading)await loading;if(!valid(stamp,name))return;
   const context=app.getHostContext(),mode=context?.displayMode==='fullscreen'?'inline':'fullscreen';
   if(!context?.availableDisplayModes?.includes(mode)){note(stamp,name,'此宿主当前不支持所选显示方式。');return;}
   const result=await app.requestDisplayMode({mode});if(!valid(stamp,name))return;
   if(result.mode!==mode){note(stamp,name,'宿主未采用所选显示方式；原偏好仍保留。');return;}
   if(!scope||revision===null){note(stamp,name,'显示已调整；当前连接尚未核对，未保存本机偏好。');return;}
   const saved=await call('save',{mode,expectedRevision:revision},stamp,name);revision=saved.revision;
   note(stamp,name,'显示偏好已保存到本机，仅用于此主体和此宿主。');
  }catch{note(stamp,name,'显示可能已调整，但本机偏好未确认保存。刷新当前资料后再试。');}
  finally{if(valid(stamp,name))busy=false;}
 }
 return{receive,toggle,close:()=>{closed=true;epoch++;scope=null;status.remove();}};
}
