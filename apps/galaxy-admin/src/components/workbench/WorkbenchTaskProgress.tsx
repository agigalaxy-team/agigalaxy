import type {ConversationTaskProgress} from '../../lib/workbench/agentos-client';
const labels:Record<ConversationTaskProgress['phase'],string>={continue:'处理中',completed:'已完成','waiting-confirmation':'等待确认','needs-information':'等待补充','waiting-result':'等待结果',blocked:'暂时受阻',interrupted:'已中断'};
export function WorkbenchTaskProgress({progress}:{progress?:ConversationTaskProgress}){
 if(!progress||typeof progress.rootOperationId!=='string'||!Object.hasOwn(labels,progress.phase)||!Array.isArray(progress.remaining))return null;
 const phase=progress.phase==='completed'&&progress.remaining.length?'continue':progress.phase;
 return <div className="wb-task-progress" data-task-phase={phase} role="status"><span className="wb-task-progress-label">任务 · {labels[phase]}</span>{progress.remaining.length>0&&<details><summary>剩余事项</summary><ul>{progress.remaining.filter(item=>typeof item==='string').map((item,index)=><li key={index}>{item}</li>)}</ul></details>}</div>;
}
