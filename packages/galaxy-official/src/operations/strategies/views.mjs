import {ServiceError} from '../../shared/service-error.mjs';

export const fail=(code,status=409)=>{throw new ServiceError(code,status);};
export const iso=v=>new Date(v).toISOString();
export const versionView=r=>r?{id:r.id,version:r.version,configuration:r.configuration,createdBy:r.created_by,createdByDisplayName:r.created_by_display_name??null,createdAt:iso(r.created_at),parentVersionId:r.parent_id??null,ordinaryStrategyId:r.ordinary_strategy_id??null,ordinaryExecutionId:r.ordinary_execution_id??null}:null;
export const nativeSummary=x=>x?{runId:x.runId,status:x.status,awaitingHuman:x.awaitingHuman===true,pauseKind:x.pauseKind??null,pauseId:x.pauseId??null,steps:x.steps??[],currentStep:x.currentStep??null,workflowId:x.workflowId,workflowVersion:x.workflowVersion}:null;
export const actionFor=kind=>kind==='draft'?'strategies.configure':kind==='publish'?'strategies.publish':'strategies.control';
