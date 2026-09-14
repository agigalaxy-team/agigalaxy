import * as z from 'zod/v4';
import { taskQueryV2Schema, taskReceiptV2Schema } from './shared/task-schema-v2.mjs';

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
  };
}
