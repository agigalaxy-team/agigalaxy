import * as z from 'zod/v4';
import {
  discoveryQueryV2Schema,
  discoveryDetailV2Schema,
} from './shared/discovery-schema-v2.mjs';
import {
  projectEnvelopeV2Schema,
  projectPreferenceV2Schema,
} from './shared/projects-schema-v2.mjs';
import { contactEnvelopeV2Schema } from './shared/contacts-schema-v2.mjs';
import {
  recruitmentEnvelopeV2Schema,
  recruitmentQueryV2Schema,
  recruitmentOperationReceiptQuerySchema,
} from './shared/recruitment-schema-v2.mjs';
export function discoveryToolDefinitions(services, actor) {
  const tool = (inputSchema, description, run, write = false) => ({
    scope: 'history',
    inputSchema,
    description,
    run,
    write,
  });
  const page = {
    after: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  };
  return {
    galaxy_discovery_v2_query: tool(
      discoveryQueryV2Schema,
      'Query with a temporary functional goal or current project. No failed Case is required. Return help, participants and exact source versions; the user model interprets relevance. Query creates no contact.',
      (x) => services.discovery.v2.query(actor, x),
    ),
    galaxy_discovery_v2_detail: tool(
      discoveryDetailV2Schema,
      'Read the exact selected opportunity and currently authorized history, including unknown or absent history. Preserve the exact opportunityRef for any later contact.',
      (x) => services.discovery.v2.detail(actor, x),
    ),
    galaxy_project_v2_query: tool(
      z.strictObject(page),
      'List managed projects and the caller’s current pending transfer offers. An offer does not disclose private project contents.',
      (x) => services.projects.list(actor, x),
    ),
    galaxy_project_v2_get: tool(
      z.strictObject({ projectId: z.uuid() }),
      'Read current project fields, permissions and permitted management offers. Self-declaration is not legal ownership or verified capability.',
      (x) => services.projects.get(actor, x.projectId),
    ),
    galaxy_project_v2_event: tool(
      projectEnvelopeV2Schema,
      'Submit exact locally signed project.write bytes for create, patch, role grant/revoke, transfer offer/accept/cancel, archive or restore. Use current revision. Transfer acceptance belongs only to its actual recipient. After unknown delivery read current object then retry the identical operation and Consent; do not invent a new operation.',
      (x) => services.projects.submit(actor, x),
      true,
    ),
    galaxy_project_v2_preferences: tool(
      z.strictObject({ projectId: z.uuid() }),
      'Read the caller’s project-specific discovery override; global explicit off/pause still wins.',
      (x) => services.projects.preferences(actor, x.projectId),
    ),
    galaxy_project_v2_preferences_save: tool(
      projectPreferenceV2Schema.extend({ projectId: z.uuid() }),
      'Save the explicitly selected project override, or null to restore global settings. This does not publish project data or send invitations.',
      ({ projectId, ...x }) =>
        services.projects.savePreferences(actor, projectId, x),
      true,
    ),
    galaxy_contacts_v2_query: tool(
      z.strictObject({
        ...page,
        direction: z.enum(['both', 'incoming', 'outgoing']).default('both'),
      }),
      'Read actual independent contacts and responses. Keep these separate from a suggested candidate list; sent does not mean accepted.',
      (x) => services.contacts.query(actor, x),
    ),
    galaxy_contact_v2_get: tool(
      z.strictObject({ contactId: z.uuid() }),
      'Reconcile a contact by stable ID. Only an actually accepted contact with returned roomId can enter the ordinary room; no Task is created.',
      (x) => services.contacts.get(actor, x.contactId),
    ),
    galaxy_contact_v2_event: tool(
      contactEnvelopeV2Schema,
      'Submit one exact locally signed contact.write send/accept/decline/withdraw. Send includes the exact query opportunityRef, recipient and purpose. A user-approved multi-selection means independent calls and per-recipient results, never accepting on behalf of the recipient or auto-adding them to a group.',
      (x) => services.contacts.submit(actor, x),
      true,
    ),
    galaxy_recruitment_v2_query: tool(
      recruitmentQueryV2Schema,
      'Find current role opportunities or managed recruiting statements. Recruitment can stay independent of any concrete Task.',
      (x) => services.recruitment.query(actor, x),
    ),
    galaxy_recruitment_v2_get: tool(
      z.strictObject({ recruitmentId: z.uuid() }),
      'Read current role statement, expiry, authority and permitted actual Task links. Expiry or pause does not finish or cancel linked Tasks.',
      (x) => services.recruitment.get(actor, x.recruitmentId),
    ),
    galaxy_recruitment_v2_receipt: tool(
      recruitmentOperationReceiptQuerySchema,
      'Reconcile your original Recruitment operationId, recruitmentId and exact payloadJson SHA256 without replaying a publication. Returns only retained author acceptance metadata, including after representative withdrawal or a newer owner statement; no old material, current role or source access. Absence means no retained owner operation, not proof it never occurred.',
      (x) => services.recruitment.operationReceipt(actor, x),
    ),
    galaxy_recruitment_v2_event: tool(
      recruitmentEnvelopeV2Schema,
      'Submit exact locally signed recruitment.write create/revise/renew/pause/close/link-task. After an unknown result first query galaxy_recruitment_v2_receipt with the original operationId and exact byte hash; do not infer acceptance from the current statement or issue a new operation. Publication and renewal share real Account task quotas. Link only an existing exact-version requester Task; it additionally needs assistance scope. Never fabricate a Task for ordinary conversation.',
      (x) => services.recruitment.submit(actor, x),
      true,
    ),
  };
}
