import * as z from 'zod/v4';
const compareText=(left,right)=>left<right?-1:left>right?1:0;

const id = z.string().min(1).max(512);
const owner = {galaxyId: id.optional()};
const sequence = z.number().int().nonnegative();
export const workOutcomeSchema = z.enum(['unknown', 'reported-success', 'reported-failure', 'partial', 'cancelled']);
export const workListInputSchema = z.strictObject({...owner, host: id.optional(), limit: z.number().int().min(1).max(100).default(20), after: z.string().regex(/^\d+$/).optional()});
export const workGetInputSchema = z.strictObject({...owner, workId: id.optional(), host: id.optional(), sessionId: id.optional(), afterSequence: sequence.default(0), limit: z.number().int().min(1).max(200).default(100)})
  .refine(x => !!x.workId || !!(x.host && x.sessionId), 'A workId or host and sessionId is required');
export const workPendingInputSchema = z.strictObject({...owner, workId: id, limit: z.number().int().min(1).max(200).default(100)});
export const workExportInputSchema = z.strictObject({...owner, workId: id});
export const workDeleteInputSchema = z.strictObject({...owner, workId: id});
export const workSummaryInputSchema = z.strictObject({...owner, workId: id, expectedRevision: sequence, throughSequence: sequence,
  sourceObservationIds: z.array(id).min(1).max(500), title: z.string().min(1).max(180), summary: z.string().min(1).max(12000),
  outcome: workOutcomeSchema.default('unknown'), model: z.string().min(1).max(256).optional(),
  execution: z.strictObject({host: id, sessionId: id, messageId: id.optional()}).optional()});
export const workNoteInputSchema = z.strictObject({...owner, host: id, sessionId: id, sourceId: id.optional(),
  title: z.string().max(180).optional(), text: z.string().min(1).max(4000), sourceKind: z.enum(['user-statement', 'model-report']).default('model-report')});
export const workEnvironmentInputSchema = z.strictObject({...owner, host: id, sessionId: id, facts: z.record(z.string(), z.unknown()), observedAt: z.iso.datetime().optional()});
export const workObservationInputSchema = z.strictObject({...owner, host: id, sessionId: id, sourceId: id,
  revision: sequence.optional(), kind: z.enum(['message', 'tool', 'session', 'artifact', 'claim', 'gap']),
  occurredAt: z.iso.datetime().optional(), title: z.string().max(180).optional(),
  source: z.strictObject({kind: z.enum(['host-event', 'user-statement', 'model-report', 'tool-report', 'external-material']),
    messageId: id.optional(), partId: id.optional(), eventId: id.optional(), locator: z.string().max(2048).optional()}),
  content: z.strictObject({excerpt: z.string().max(4000).default(''), originalLength: sequence.optional(),
    retained: z.enum(['none', 'excerpt', 'full']).default('none'), availableFromHost: z.boolean().default(false)}).optional(),
  details: z.record(z.string(), z.unknown()).default({}), environment: z.record(z.string(), z.unknown()).optional()});

// Only actual, non-secret environment facts. A caller cannot smuggle a provider
// configuration, credentials or environment variables into a generic snapshot.
export function normalizeWorkEnvironment(value = {}) {
  const result = {};
  for (const key of ['host', 'hostVersion', 'platform', 'architecture', 'runtime', 'runtimeVersion', 'configuredModel', 'selectedModel', 'actualModel']) {
    if (typeof value[key] === 'string' && value[key]) result[key] = value[key].slice(0, 256);
  }
  if (Array.isArray(value.tools)) result.tools = [...new Set(value.tools.filter(x => typeof x === 'string').map(x => x.slice(0, 160)))].sort(compareText).slice(0, 256);
  return result;
}

export function parseWorkInput(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error('local_work_input_invalid'), {code: 'local_work_input_invalid'});
  return parsed.data;
}
