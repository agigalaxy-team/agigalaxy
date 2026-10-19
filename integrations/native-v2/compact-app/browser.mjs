import {App} from '@modelcontextprotocol/ext-apps';
import {mountCompactPanel,compactCss} from './view.mjs';
import {mountWorkerPanel} from './worker-view.mjs';
import {workerComponentResult} from './worker-result.mjs';
import {mountHostViewPreferences} from './host-view-preferences.mjs';
import {hostWorkContinuation,hostDirectionContinuation} from './host-continuation.mjs';
import {mountLocalWorkPanel,localWorkCss} from './local-work-view.mjs';
const style=document.createElement('style');style.textContent=compactCss;document.head.append(style);
const localStyle=document.createElement('style');localStyle.textContent=localWorkCss;document.head.append(localStyle);
const app=new App({name:'Galaxy help panel',version:'0.1.0'},{});
const preferences=mountHostViewPreferences(app,document.getElementById('galaxy'));
const controls={
 call:(name,args)=>app.callServerTool({name,arguments:args}),
 displayMode:preferences.toggle,
 supportsDisplayMode:()=>app.getHostContext()?.availableDisplayModes?.includes('fullscreen'),
 supportsOpenLink:()=>!!app.getHostCapabilities()?.openLinks,
 openLink:async url=>{if(!app.getHostCapabilities()?.openLinks)throw new Error('host_open_links_unavailable');return app.openLink({url});},
 supportsHandoff:()=>!!app.getHostCapabilities()?.updateModelContext,
 handoff:async(refs,view)=>{if(!app.getHostCapabilities()?.updateModelContext)throw new Error('host_model_context_unavailable');await app.updateModelContext(hostWorkContinuation(refs,view));},
 selectPath:async choice=>{if(!app.getHostCapabilities()?.updateModelContext)throw new Error('host_model_context_unavailable');
  await app.updateModelContext(hostDirectionContinuation(choice));},
 continueLocalWork:async work=>{if(!app.getHostCapabilities()?.updateModelContext)throw new Error('host_model_context_unavailable');
  await app.updateModelContext({content:[{type:'text',text:'请用我自己的 Agent 整理这段本机工作的尚未处理增量。先调用 galaxy_local_work_pending，按实际来源更新摘要。不要上传原文，不要推断能力，也不要将陈述冒充宿主事实。'}],structuredContent:{kind:'galaxy-local-work-continue',...work,modelStarted:false,uploadRequested:false}});}
};
let mode='help',view=mountCompactPanel(document.getElementById('galaxy'),controls);
app.addEventListener('toolresult',result=>{
 preferences.receive(result);
 const data=workerComponentResult(result);
 const next=data?.kind==='galaxy-local-work-panel'?'local':data?.kind==='galaxy-worker-panel'?'worker':data?.kind==='galaxy-a2a-panel'?'a2a':data?.schemaVersion===1&&data?.viewId?'help':mode;
 if(next==='local'&&app.getHostContext()?.displayMode==='fullscreen'&&app.getHostContext()?.availableDisplayModes?.includes('inline'))void app.requestDisplayMode({mode:'inline'}).catch(()=>{});
 if(next!==mode){view.close();mode=next;view=(mode==='local'?mountLocalWorkPanel:mode==='worker'||mode==='a2a'?mountWorkerPanel:mountCompactPanel)(document.getElementById('galaxy'),{...controls,purpose:mode});}
 view.receive(result);
});
app.onteardown=async()=>{try{await view.flush?.();}finally{preferences.close();view.close();}return{};};
app.connect().catch(()=>{document.getElementById('galaxy').textContent='此宿主未完成 MCP Apps 连接。请继续使用原聊天的银河工具和完整网页入口。';});
