// These are the fixed SELECTs emitted by the existing anonymous public reader.
// The types belong to each exact internal template, never to caller input or an
// inferred value. A changed/unknown template keeps the original batch path.
const normalize = sql => sql.trim().replace(/\s+/g, ' ');
const templates = new Map([
  ['SELECT id,post_id,post_version_id FROM forum_replies_v1 WHERE id=$1', ['uuid']],
  ['SELECT r.*,e.payload_text,e.erased_at event_erased FROM forum_replies_v1 r LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1', ['uuid']],
  ['SELECT r.reporter_id,r.target_author_id,r.reporter_account_id,r.target_author_account_id,r.account_governance,r.restriction_event_id,e.subject_id,e.permission_id,e.payload_hash,e.effect_until FROM forum_reports_v1 r JOIN forum_governance_events_v1 e ON e.id=r.restriction_event_id WHERE r.target=$1::jsonb AND r.restriction_until>$2', ['jsonb', 'timestamptz']],
  ['SELECT v.*,e.payload_text,e.erased_at event_erased,p.state post_state,p.head_version,p.current_version_id, p.created_at post_created_at,p.updated_at post_updated_at FROM forum_versions_v1 v JOIN forum_posts_v1 p ON p.id=v.post_id LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id WHERE v.id=$1 AND v.post_id=$2', ['uuid', 'uuid']],
  ['SELECT * FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3', ['text', 'text', 'uuid']],
  ['SELECT 1 FROM forum_reports_v1 r JOIN forum_operations_events_v1 e ON e.id=r.restriction_event_id WHERE r.target=$1::jsonb AND r.restriction_until>$2 AND e.effect_until>$2 LIMIT 1', ['jsonb', 'timestamptz']],
  ['SELECT id,authorization_kind,subject_id,account_id,event_id,consent_id,origin_binding_id,source_device_id,source_key_id, accepted_epoch,accepted_control_hash,signature_hash,payload_hash,action,object_id,visibility,fields,viewers,account_viewers,issued_at,published_until, accepted_at,authorization_audit_until,revoked_at,erased_at,policy_hash FROM forum_permissions_v1 WHERE id=$1', ['uuid']],
  ['SELECT actor_kind,subject_id,account_id,consent_id,payload_hash,erased_at FROM forum_events_v1 WHERE id=$1 UNION ALL SELECT actor_kind,subject_id,account_id,consent_id,payload_hash,erased_at FROM forum_governance_events_v1 WHERE id=$1 LIMIT 1', ['uuid']],
  ['SELECT * FROM forum_replies_v1 WHERE publication_event_id=$1', ['uuid']],
  ['SELECT * FROM forum_versions_v1 WHERE publication_event_id=$1', ['uuid']],
  ['SELECT * FROM operations_forum_curation_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3', ['text', 'text', 'uuid']],
  ['SELECT id FROM community_accounts WHERE id=$1 AND endpoint=$2', ['uuid', 'text']],
  ['SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2', ['uuid', 'text']],
  ['SELECT * FROM forum_posts_v1 WHERE id=$1', ['uuid']],
  ['SELECT id,version_number FROM forum_versions_v1 WHERE post_id=$1 AND version_number>$2 ORDER BY version_number LIMIT $3', ['uuid', 'integer', 'integer']],
].map(([sql, types]) => [normalize(sql), Object.freeze(types)]));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
function valid(type, value) {
  if (value === null) return true;
  if (type === 'uuid') return typeof value === 'string' && uuid.test(value);
  if (type === 'text') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  if (type === 'timestamptz') return value instanceof Date ? Number.isFinite(value.getTime()) : typeof value === 'string' && timestamp.test(value) && Number.isFinite(Date.parse(value));
  if (type === 'jsonb') {
    if (typeof value !== 'string') return false;
    try { JSON.parse(value); return true; } catch { return false; }
  }
  return false;
}

// Only exact fixed templates are reusable, and only by the caller's current
// bounded wave. Include every typed value; no JSON/UUID/time normalization may
// collapse distinct caller bindings or an unknown SELECT into a cached result.
export function typedPublicReadKey(sql, values) {
  const template = normalize(sql), types = templates.get(template);
  if (!types) return null;
  if (!Array.isArray(values) || values.length !== types.length || values.some((value, i) => !valid(types[i], value))) throw new Error('Public reader template parameter invalid');
  return JSON.stringify([template, types.map((type, i) => [type, values[i] instanceof Date ? ['date', values[i].toISOString()] : values[i]])]);
}

export function typedPublicReadStatement(sql, calls) {
  const types = templates.get(normalize(sql));
  if (!types) return null;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 64) throw new Error('Bounded public reader calls required');
  const values = [], tuples = calls.map((call, index) => {
    if (!Array.isArray(call.values) || call.values.length !== types.length || call.values.some((value, i) => !valid(types[i], value))) throw new Error('Public reader template parameter invalid');
    const parameters = call.values.map((value, i) => { values.push(value); return `$${values.length}::${types[i]}`; });
    return `(${index}::integer,${parameters.join(',')})`;
  });
  const statement = sql.replace(/\$(\d+)/g, (_, n) => `__galaxy_public_input__.p${n}`);
  const columns = ['ordinal', ...types.map((_, i) => `p${i + 1}`)].join(',');
  // LATERAL keeps every original predicate and its per-call ORDER/LIMIT. The
  // ordinal and row number remain private; native driver rows are not JSONified.
  return {
    text: `SELECT __galaxy_public_input__.ordinal AS "__galaxy_public_read_request__",original.* FROM (VALUES ${tuples.join(',')}) AS __galaxy_public_input__(${columns}) CROSS JOIN LATERAL (SELECT row_number() OVER () AS "__galaxy_public_read_row__",source.* FROM (${statement}) source) original ORDER BY "__galaxy_public_read_request__","__galaxy_public_read_row__"`,
    values,
  };
}
