import {showExactChoice} from './exact-choice.mjs';
export function createBindingManagementMenu({controller,select,prompt,info,language,isCurrent,onBack}){
  const label=(zh,en)=>language==='en-US'?en:zh;
  let generation=0;const current=v=>isCurrent()&&generation===v;
  const stateName=state=>({active:label('有效','Active'),expired:label('已过期','Expired'),revoked:label('已撤销','Revoked')})[state];
  function message(text,back=onBack){if(!isCurrent())return;const version=++generation;
    info('Galaxy',text,()=>{if(current(version)){generation++;back();}});}
  function menu(title,entries,back){if(!isCurrent())return;const version=++generation,routes={};
    const once=fn=>()=>{if(current(version)){generation++;fn();}};
    const options=entries.map(([title,action,description=''],i)=>{routes[i+1]=once(action);return {number:String(i+1),title,description};});
    select({title,options,routes,onBack:once(back)});}
  async function run(work,done,back=onBack){if(!isCurrent())return;const version=++generation;
    info('Galaxy',label('正在读取或提交；Esc返回。','Reading or submitting; Esc returns.'),()=>{if(current(version)){generation++;controller.cancel();back();}});
    try{const result=await work();if(current(version))done(result);}
    catch(error){if(current(version))message(String(error.message),back);}
  }
  function open(input={},previous=[]){
    const back=()=>previous.length?open(previous.at(-1),previous.slice(0,-1)):onBack();
    void run(()=>controller.queryBindings({...input,limit:8}),page=>menu(
      `${label('本人设备与绑定','My installations and bindings')}\n${page.subjectId}\n${label('安装ID是软件实例标识；同一实例可能有多份绑定。','Installation IDs identify software instances; one instance may have several bindings.')}\n${input.installationId??''}`,[
        ...page.items.map(item=>[`${item.bindingId===page.currentBindingId?label('当前会话','Current session'):label('其他绑定','Other binding')} · ${stateName(item.state)} · ${item.bindingId}`,
          ()=>detail(item,()=>open(input,previous)),`${item.installationId} · ${item.expiresAt}`]),
        ...(page.nextAfter?[[label('下一页','Next page'),()=>open({...input,after:page.nextAfter},[...previous,input])]]:[]),
      ],back),back);
  }
  function detail(item,back){
    menu(`${item.installationId}\n${item.bindingId}\n${stateName(item.state)}\n${label('建立','Created')}: ${item.createdAt}\n${label('到期','Expires')}: ${item.expiresAt}\n${label('撤销','Revoked')}: ${item.revokedAt??'-'}\nScopes: ${item.scopes.join(', ')}\n${label('撤销绑定只结束此绑定；同一身份的设备撤销或恢复码恢复另行由本人确认。','Revoking a binding ends only that binding. Device revocation or same-identity recovery requires separate personal confirmation.')}`,[
      ...(item.state!=='revoked'?[[label('预览撤销此绑定','Preview revoking this binding'),()=>revoke(item.bindingId,back)]]:[]),
      [label('查看此安装实例的全部绑定','List bindings for this installation'),()=>open({installationId:item.installationId})],
      [label('返回列表','Back to list'),back],
    ],back);
  }
  function revoke(bindingId,back){void run(()=>controller.prepareBindingRevoke(bindingId),preview=>{
    const version=++generation;
    const leave=()=>{if(current(version)){generation++;controller.cancel();back();}};
    showExactChoice({preview,title:label('撤销所选设备连接','Revoke the selected device connection'),select,info,language,isCurrent:()=>current(version),onCancel:leave,onConfirm:value=>{
        if(!current(version))return;generation++;
        void run(()=>controller.executeBindingRevoke(preview,value),result=>message(label('指定绑定已撤销。','The selected binding was revoked.'),result.currentSessionEnded?onBack:back),
          ()=>message(label('若提交期间网络中断，请重新读取该绑定状态；不会自动重试。','If the network failed during submission, refresh the binding status. No automatic retry.'),onBack));
      }});
  },back);}
  return Object.freeze({open});
}
