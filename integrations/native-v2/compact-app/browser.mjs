import {App} from '@modelcontextprotocol/ext-apps';
import {mountCompactPanel,compactCss} from './view.mjs';
const style=document.createElement('style');style.textContent=compactCss;document.head.append(style);
const app=new App({name:'Galaxy compact workspace',version:'0.1.0'},{});
const view=mountCompactPanel(document.getElementById('galaxy'),{
 call:(name,args)=>app.callServerTool({name,arguments:args}),
 displayMode:async()=>{const context=app.getHostContext(),mode=context?.displayMode==='fullscreen'?'inline':'fullscreen';if(!context?.availableDisplayModes?.includes(mode))throw new Error('host_display_mode_unavailable');await app.requestDisplayMode({mode});},
 selectPath:async choice=>{if(!app.getHostCapabilities()?.updateModelContext)throw new Error('host_model_context_unavailable');
  await app.updateModelContext({content:[{type:'text',text:JSON.stringify({kind:'galaxy-help-direction-selection',...choice,meaning:'User selected a direction, not a publication/contact/payment authorization. Continue in the original chat using the current permitted data.'})}]});}
});
app.ontoolresult=result=>view.receive(result);
app.onteardown=async()=>{view.close();return{};};
app.connect().catch(()=>{document.getElementById('galaxy').textContent='此宿主未完成 MCP Apps 连接。请继续使用原聊天的银河工具和完整网页入口。';});
