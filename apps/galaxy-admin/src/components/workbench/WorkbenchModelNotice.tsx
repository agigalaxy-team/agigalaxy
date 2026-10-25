'use client';

import {useId} from 'react';
import {AdminIcon} from '../AdminIcons';
import {nativeConversationFailure,type AgentOsNativeRun} from '../../lib/agentos-client';

export function WorkbenchModelNotice({run,canSend,busy,onRetry}:{run:AgentOsNativeRun;canSend:boolean;busy:boolean;onRetry:()=>void}){
 const id=useId(),failure=nativeConversationFailure(run);
 return <div className="wb-model-notice" role="status">
  <span className="wb-model-notice-label" tabIndex={0} aria-describedby={id} title={failure.detail+' '+failure.processingNotice}><AdminIcon name="warning" size={15}/><span>{failure.title}</span></span>
  <span id={id} className="wb-visually-hidden">{failure.detail} {failure.processingNotice}</span>
  {failure.canRetry&&<button type="button" className="wb-notice-retry" disabled={!canSend||busy} onClick={onRetry} title="重试这次提问" aria-label="重试这次提问"><AdminIcon name="refresh" size={14}/><span>重试</span></button>}
 </div>;
}
