'use client';

import {useId} from 'react';
import {AdminIcon} from '../AdminIcons';
import {nativeConversationFailure,type AgentOsNativeRun} from "../../lib/workbench/agentos-client";

export function WorkbenchModelNotice({run}:{run:AgentOsNativeRun}){
 const id=useId(),failure=nativeConversationFailure(run);
 return <div className="wb-model-notice" role="alert">
  <span className="wb-model-notice-label" tabIndex={0} aria-describedby={id} title={failure.detail+' '+failure.processingNotice}><AdminIcon name="warning" size={15}/><span>{failure.title}</span></span>
  <span id={id} className={failure.canRetry?'wb-visually-hidden':'wb-model-notice-detail'}>{failure.detail} {failure.processingNotice}</span>
 </div>;
}
