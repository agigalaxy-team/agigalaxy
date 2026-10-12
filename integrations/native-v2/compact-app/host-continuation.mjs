import {panelText} from './presentation.mjs';
import {workerPanelText} from './worker-result.mjs';

// updateModelContext supports readable content and a separate structured
// payload. Unsent editors and local notes are never part of this selection.
export function hostWorkContinuation(refs,view){
 const worker=['galaxy-worker-panel','galaxy-a2a-panel'].includes(view?.kind);
 const selected=view?.help?.selectedHelpIds??[];
 const association=view?.selected?.association;
 const current=worker?{kind:view.kind,selected:view.selected?{association:association?Object.fromEntries(['associationId','purpose','taskId','caseId','attempt','pack','peerId'].filter(key=>Object.hasOwn(association,key)).map(key=>[key,association[key]])):null,
   peer:view.selected.peer?{peer:view.selected.peer.peer??null,status:view.selected.peer.status??null}:null}:null,actionResult:view.actionResult??null}
  :{object:view?.object??null,source:view?.sourceError?null:view?.source??null,sourceError:view?.sourceError??null,
   help:view?.help?{offers:(view.help.offers??[]).filter(offer=>offer.state==='current'&&selected.includes(offer.id))}:null,
   actionResult:view?.actionResult??null,messageResult:view?.messageResult??null};
 const text=worker?workerPanelText(current):panelText(current);
 return{content:[{type:'text',text:text+'\n\n接着原来的事情使用以上当前内容。尚未取得的结果保持未知；这次返回不会发送消息、扩大材料范围或证明方法复用成功。'}],
  structuredContent:{kind:'galaxy-return-to-current-work',...refs,current,businessMutation:false,permissionExpanded:false,modelStarted:false}};
}
export function hostDirectionContinuation(choice){
 const names={consult:'继续讨论思路',request:'准备求助',candidate:'寻找协助者',methods:'查找可用方法'};
 return{content:[{type:'text',text:'我选择'+(names[choice?.path]??names[choice?.id]??'这个帮助方向')+'，请围绕当前工作取得获准资料并继续。这次选择不代表发布、联系或新增资料授权。'}],
  structuredContent:{kind:'galaxy-help-direction-selection',...choice,businessMutation:false,permissionExpanded:false}};
}
