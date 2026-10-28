// Render only Native's bounded boolean-confirm form through the actual host
// DialogSelect. No confirmation is inferred from tool arguments or model text.
export function createHostInputHandler(getApi){
 return (params,{signal}={})=>new Promise((resolve,reject)=>{
  const api=getApi(),schema=params?.requestedSchema;
  if(!api?.ui||params?.mode!=='form'||schema?.properties?.confirm?.type!=='boolean'||schema?.required?.length!==1||schema.required[0]!=='confirm')return reject(Error('native_bridge_input_unsupported'));
  let settled=false;
  const finish=action=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);resolve({action,...(action==='accept'?{content:{confirm:true}}:{})});};
  const cancel=()=>finish('cancel');
  if(signal?.aborted){cancel();return;}
  signal?.addEventListener('abort',cancel,{once:true});
  api.ui.dialog.setSize('xlarge');
  api.ui.dialog.replace(()=>api.ui.DialogSelect({title:params.message,skipFilter:true,options:[
   {title:'允许本次内容与范围',value:'allow',disabled:false,onSelect:()=>finish('accept')},
   {title:'取消',value:'cancel',disabled:false,onSelect:()=>finish('decline')},
  ]}),cancel);
 });
}
