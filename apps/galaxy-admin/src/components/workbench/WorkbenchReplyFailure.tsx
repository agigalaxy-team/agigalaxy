import {AdminIcon} from '../AdminIcons';
import {nativeConversationFailure,type AgentOsNativeRun} from "../../lib/workbench/agentos-client";

export function WorkbenchReplyFailure({run,canSend,busy,onRetry}:{run:AgentOsNativeRun;canSend:boolean;busy:boolean;onRetry:()=>void}){
 const failure=nativeConversationFailure(run);
 return <div className="wb-reply-failure" role="alert">
  <div className="wb-reply-failure-heading"><AdminIcon name="warning" size={17}/><strong>{failure.title}</strong></div>
  <p>{failure.detail}</p><p className="wb-reply-failure-notice">{failure.processingNotice}</p>
  {failure.canRetry&&<button type="button" className="wb-reply-retry" disabled={!canSend||busy} onClick={onRetry}><AdminIcon name="refresh" size={14}/>重试这次提问</button>}
 </div>;
}
