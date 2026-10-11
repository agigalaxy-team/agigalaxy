import {App} from '@modelcontextprotocol/ext-apps';
import {mountCompactPanel,compactCss} from './view.mjs';
import {mountWorkerPanel} from './worker-view.mjs';
import {workerComponentResult} from './worker-result.mjs';
import {mountHostViewPreferences} from './host-view-preferences.mjs';
const style=document.createElement('style');style.textContent=compactCss;document.head.append(style);
const app=new App({name:'Galaxy help panel',version:'0.1.0'},{});
const preferences=mountHostViewPreferences(app,document.getElementById('galaxy'));
const controls={
 call:(name,args)=>app.callServerTool({name,arguments:args}),
 displayMode:preferences.toggle,
 supportsDisplayMode:()=>app.getHostContext()?.availableDisplayModes?.includes('fullscreen'),
 supportsOpenLink:()=>!!app.getHostCapabilities()?.openLinks,
 openLink:async url=>{if(!app.getHostCapabilities()?.openLinks)throw new Error('host_open_links_unavailable');return app.openLink({url});},
 supportsHandoff:()=>!!app.getHostCapabilities()?.updateModelContext,
 handoff:async refs=>{if(!app.getHostCapabilities()?.updateModelContext)throw new Error('host_model_context_unavailable');await app.updateModelContext({content:[{type:'text',text:JSON.stringify({kind:'galaxy-return-to-current-work',...refs,meaning:'Continue the original work using current permitted references. No task cancellation, success assertion or new authorization.'})}]});},
 selectPath:async choice=>{if(!app.getHostCapabilities()?.updateModelContext)throw new Error('host_model_context_unavailable');
  await app.updateModelContext({content:[{type:'text',text:JSON.stringify({kind:'galaxy-help-direction-selection',...choice,meaning:'User selected a direction, not a publication/contact/payment authorization. Continue in the original chat using the current permitted data.'})}]});}
};
let mode='help',view=mountCompactPanel(document.getElementById('galaxy'),controls);
app.addEventListener('toolresult',result=>{
 preferences.receive(result);
 const data=workerComponentResult(result);
 const next=data?.kind==='galaxy-worker-panel'?'worker':data?.kind==='galaxy-a2a-panel'?'a2a':data?.schemaVersion===1&&data?.viewId?'help':mode;
 if(next!==mode){view.close();mode=next;view=(mode==='worker'||mode==='a2a'?mountWorkerPanel:mountCompactPanel)(document.getElementById('galaxy'),{...controls,purpose:mode});}
 view.receive(result);
});
app.onteardown=async()=>{try{await view.flush?.();}finally{preferences.close();view.close();}return{};};
app.connect().catch(()=>{document.getElementById('galaxy').textContent='此宿主未完成 MCP Apps 连接。请继续使用原聊天的银河工具和完整网页入口。';});
