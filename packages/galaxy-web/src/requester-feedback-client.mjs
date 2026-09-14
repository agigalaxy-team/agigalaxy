import {participationEventV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';

export const requesterFeedbackAvailable=(task,participant,subjectId)=>participant.subjectId===subjectId
  && Number.isSafeInteger(participant.confirmedAt)
  && (['accepted','withdrawn','closed'].includes(participant.state)||['canceled','closed'].includes(task.state));
export function requesterFeedbackPreview(task,participant,subjectId,draft){
 if(!requesterFeedbackAvailable(task,participant,subjectId))throw Error('只有实际确认参与的本人，在该次参与结束或任务取消后才能记录合作反馈。');
 if(!['yes','no'].includes(draft.scopeMatched))throw Error('请选择实际工作是否符合约定范围。');
 const parsed=participationEventV2Schema.parse({eventId:'00000000-0000-4000-8000-000000000001',kind:'requester-feedback',
  expectedParticipationVersion:participant.version,descriptionClarity:draft.descriptionClarity,scopeMatched:draft.scopeMatched==='yes',note:draft.note,
  ...(participant.feedback?{supersedes:participant.feedback.eventId,reason:draft.reason}:{})});
 const {eventId,...event}=parsed;
 return {taskId:task.taskId,participationId:participant.participationId,authorId:subjectId,requesterId:task.requesterId,event,
  viewers:[...new Set([subjectId,task.requesterId])],visibility:'Private',authority:'provider-reported',independentQualityRating:false};
}
export function submitRequesterFeedback(runtime,preview){
 return runtime.participationEvent(preview.taskId,preview.participationId,preview.event,{confirmed:true,viewers:preview.viewers});
}
