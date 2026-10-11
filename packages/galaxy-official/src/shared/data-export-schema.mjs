import { z } from 'zod';
import { productV2ExportDatasets } from './product-v2-export-datasets.mjs';
export const ownerExportDatasets = ['identity', 'external-identity-links', 'bindings', 'consents', 'cases', 'case-events', 'evidence', 'observations', 'proofs',
  'assistance-requests', 'assistance-events', 'context-grants', 'context-acceptances', 'notification-preferences', 'notification-reads',
  'moderation-reports', 'moderation-events', 'capsules', 'capsule-events', 'capsule-uses', 'builders', 'builder-events', 'audit',
  'audit-access-grants', 'audit-reads', 'export-reads', 'deletion-requests', 'deletion-events', 'deletion-executions', 'incident-notices', 'profile-statements', 'builder-probes', ...productV2ExportDatasets];
export const exportViewScopes = { 'forum-post-version':'assistance','forum-reply':'assistance', 'builder-support':'builders', 'choice-snapshot':'binding', recruitment:'history', project: 'history', contact: 'history', 'personal-summary': 'binding', assistance: 'assistance', task: 'assistance', case: 'case-teaser', evidence: 'evidence', verification: 'evidence', context: 'context', proof: 'proof', capsule: 'capsules', builder: 'builders', moderation: 'moderation' };
export const exportViewSchema = z.object({ kind: z.enum(Object.keys(exportViewScopes)),
  id: z.uuid(), versionId: z.uuid().optional(), version: z.number().int().positive().optional(), taskId: z.uuid().optional() }).strict()
  .refine(value => (!value.versionId || ['capsule','forum-post-version'].includes(value.kind)) && (value.kind!=='forum-post-version'||!!value.versionId) && (!value.version || ['evidence','verification'].includes(value.kind)) && (!value.taskId || value.kind === 'case'));
export const exportDatasets = [...ownerExportDatasets, 'authorized-views'];
export const sameExportViews = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
  && left.every((value, index) => value?.kind === right[index]?.kind && value?.id === right[index]?.id && value?.versionId === right[index]?.versionId
    && value?.version === right[index]?.version && value?.taskId === right[index]?.taskId);
export const exportCreateSchema = z.object({ id: z.uuid(), datasets: z.array(z.enum(exportDatasets)).min(1).max(exportDatasets.length)
  .refine(values => new Set(values).size === values.length).default(ownerExportDatasets),
  views: z.array(exportViewSchema).max(32).refine(values => new Set(values.map(value => JSON.stringify(value))).size === values.length).default([]),
}).strict().refine(value => value.datasets.includes('authorized-views') === (value.views.length > 0));
export const exportIdSchema = z.object({ id: z.uuid() }).strict();
export const exportPageSchema = z.object({ id: z.uuid(), dataset: z.enum(exportDatasets),
  after: z.string().max(200).regex(/^[a-zA-Z0-9:._-]*$/).default(''), limit: z.number().int().min(1).max(100).default(50) }).strict();
export const exportBinarySchema = z.object({ id: z.uuid(), dataset: z.literal('outcome-materials-v2'), recordId: z.uuid(),
  offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(524288).default(524288) }).strict();
