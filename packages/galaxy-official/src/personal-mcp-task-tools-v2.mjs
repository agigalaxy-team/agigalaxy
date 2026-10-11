import * as z from 'zod/v4';
import { taskQueryV2Schema, taskReceiptV2Schema } from './shared/task-schema-v2.mjs';
import {taskOwnerReadPrepareV2Schema,taskOwnerReadRequestV2Schema} from './shared/task-owner-read-v2-schema.mjs';
import {taskOwnerControlPrepareV2Schema,taskOwnerControlRequestV2Schema} from './shared/task-owner-control-v2-schema.mjs';

// Transport grants permit the operation category; mutations still require an
// existing locally signed exact Consent, checked by the persistent M11 service.
export function taskToolDefinitions(services, actor) {
  const submission = { consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) };
  const tool = (inputSchema, description, run, write = false) => ({ scope: 'assistance', inputSchema, description, run, write });
  return {
    galaxy_tasks_v2_query: tool(taskQueryV2Schema,
      'Find open tasks, owner requests or current participation. Active match, publish and participation remain separate available entries.', input => services.assistance.queryTasks(actor, input)),
    galaxy_task_v2_get: tool(z.strictObject({ taskId: z.uuid() }),
      'Read a real Task, private authorized suggestions, separate invitations/applications and multiple Participation records. A receipt never grants current access.', input => services.assistance.getTask(actor, input.taskId)),
    galaxy_task_v2_create: tool(z.strictObject(submission),
      'Publish exact reviewed Task bytes with existing signed Consent. A proactive Task needs no invented Case or failure. Public Account quotas and paid eligibility remain enforced.', input => services.assistance.createTask(actor, input), true),
    galaxy_task_v2_event: tool(z.strictObject({ taskId: z.uuid(), ...submission }),
      'Submit a Task event covered by exact signed Consent: private suggestions, invitations, responses, applications or enrollment changes. Suggestions do not send invitations.',
      ({ taskId, ...signed }) => services.assistance.submitTaskEvent(actor, taskId, signed), true),
    galaxy_participation_v2_propose: tool(z.strictObject({ taskId: z.uuid(), ...submission }),
      'Propose one participant scope using exact signed Consent; provider confirmation is separate and other participants remain independent.',
      ({ taskId, ...signed }) => services.assistance.proposeParticipation(actor, taskId, signed), true),
    galaxy_participation_v2_event: tool(z.strictObject({ participationId: z.uuid(), ...submission }),
      'Submit one participation confirmation, delivery, acceptance, withdrawal or scope/dispute event with existing exact signed Consent. It cannot overwrite other participants.',
      ({ participationId, ...signed }) => services.assistance.submitParticipationEvent(actor, participationId, signed), true),
    galaxy_task_v2_receipt: tool(taskReceiptV2Schema,
      'Check the original operation ID and payload hash after an unknown response. Do this before any new publication or dependent invitation.', input => services.assistance.taskReceipt(actor, input)),
    galaxy_task_v2_owner_read_prepare: tool(taskOwnerReadPrepareV2Schema,
      'Prepare exact metadata and current device scope for an explicit fresh owner read after same-ID recovery. This does not disclose retained text or restore shared access.',
      input => services.taskOwnerRead.prepare(actor,input)),
    galaxy_task_v2_owner_read: tool(z.strictObject({taskId:z.uuid(),...taskOwnerReadRequestV2Schema.shape}),
      'Read only currently authorized retained authored events with an existing locally signed task.owner-read Consent over the exact prepared descriptor. Returns a partial event set, never a complete Task or Task write permission.',
      ({taskId,...signed}) => services.taskOwnerRead.read(actor,taskId,signed)),
    galaxy_task_v2_owner_control_prepare: tool(taskOwnerControlPrepareV2Schema,
      'Prepare one explicit owner cancel or close after same-ID recovery, with exact event bytes, current version and private authorization scope. Query the original receipt first if an operation may already have been accepted.',
      input => services.taskOwnerControl.prepare(actor,input)),
    galaxy_task_v2_owner_control: tool(z.strictObject({taskId:z.uuid(),...taskOwnerControlRequestV2Schema.shape}),
      'Execute one explicitly reviewed cancel or close using an existing locally signed exact private assistance.publish Consent. A read permit cannot authorize this write. Preserve the original event ID and bytes; after an unknown response query the original receipt before retrying. Ending a Task retains history and does not revoke materials or settle payments.',
      ({taskId,...signed}) => services.taskOwnerControl.execute(actor,taskId,signed),true),
  };
}
