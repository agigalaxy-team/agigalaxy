import {caseEventV2Schema,taskCaseContainerSummary,taskMaterialCaseContainerTitle} from '../../../../galaxy-official/src/shared/cases-schema.mjs';
import {verificationEventSchema} from '../../../../galaxy-official/src/shared/verification-record-schema.mjs';
/** @typedef {import('./client.mjs').FactWriteOptions} FactWriteOptions */

// Build business payloads; the shared client owns authorization, queue and receipts.
export function createFactSubmissions({subjectId,write}){
  /** @param {any} task @param {any} facts @param {any} participant @param {any} fields @param {FactWriteOptions} options */
  function submitFact(
    task,
    facts,
    participant,
    fields,
    { confirmed = false, viewers = [], caseSummary, synthetic = false,composeRevision } = {},
  ) {
    if (participant && participant.subjectId !== subjectId)
      throw new Error('不能以他人的参与关系声明工作。');
    const caseId = task.caseId ?? crypto.randomUUID(),
      eventId = crypto.randomUUID();
    const common = {
      caseId,
      eventId,
      actorId: subjectId,
      taskId: task.taskId,
      expectedVersion: facts?.version ?? 1,
      taskScopeVersion: fields.taskScopeVersion ?? facts?.scopeVersion ?? 1,
      ...(participant
        ? {
            participationId: participant.participationId,
            participationScopeVersion: participant.scopeVersion,
          }
        : {}),
    };
    const payload = caseEventV2Schema.parse({ ...fields, ...common });
    if (!task.caseId) {
      if (
        task.requesterId !== subjectId && (!participant || !['active','delivered','accepted','disputed'].includes(participant.state)) ||
        !['attempt-start', 'intervention'].includes(payload.kind)
      )
        throw new Error(
          '由请求者或已确认参与者保存本人真实尝试或介入，关联这次协作记录。',
        );
      const root = caseEventV2Schema.parse({
        kind: 'case-created',
        caseId,
        eventId: caseId,
        expectedVersion: 0,
        actorId: subjectId,
        taskId: task.taskId,
        taskScopeVersion:common.taskScopeVersion,
        ...(participant?{participationId:participant.participationId,participationScopeVersion:participant.scopeVersion}:{}),
        localRef: task.taskId,
        title: task.textView?.format==='task-text-view-v1'?taskMaterialCaseContainerTitle:task.request.title,
        summary: participant ? taskCaseContainerSummary : caseSummary?.trim()?caseSummary:taskCaseContainerSummary,
        source: { kind: 'active-task', reference: task.taskId },
        synthetic,
      });
      return write(
        task,
        {
          kind: 'case-link',
          operationId: crypto.randomUUID(),
          caseId,
          expectedTaskVersion: task.version,
          path: `/v2/tasks/${task.taskId}/case`,
          items: [root, payload].map((payload) => ({
            action: 'case.teaser.publish',
            payload,
          })),
        },
        { confirmed, viewers,composeRevision },
      );
    }
    return write(
      task,
      {
        kind: 'fact',
        operationId: eventId,
        caseId,
        path: '/v2/cases/events',
        items: [{ action: 'case.teaser.publish', payload }],
      },
      { confirmed, viewers,composeRevision },
    );
  }
  /** @param {any} task @param {any} facts @param {any} participant @param {any} fields @param {FactWriteOptions} options */
  function submitRecord(task, facts, participant, fields, options = {}) {
    if (!task.caseId)
      throw new Error('先关联实际工作Case，再保存相应证据或检查。');
    if (participant && participant.subjectId !== subjectId)
      throw new Error('不能以他人的参与关系报告。');
    const payload = verificationEventSchema.parse({
      ...fields,
      id: fields.id ?? crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      caseId: task.caseId,
      reportedBy: subjectId,
      taskId: task.taskId,
      ...(participant
        ? {
            participationId: participant.participationId,
            participationScopeVersion: participant.scopeVersion,
          }
        : {}),
      synthetic: facts.synthetic === true || fields.synthetic === true,
    });
    return write(
      task,
      {
        kind: 'verification',
        operationId: payload.operationId,
        caseId: task.caseId,
        path: '/v2/verification-records/submit',
        items: [{ action: 'evidence.submit', payload }],
      },
      options,
    );
  }
  return {submitFact,submitRecord};
}
