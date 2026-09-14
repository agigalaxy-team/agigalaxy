import * as z from 'zod/v4';
import canonicalize from 'canonicalize';
import { honorRuleSchema } from '../shared/honor-schema.mjs';
import { digest } from '../shared/digest.mjs';
import { ServiceError } from '../shared/service-error.mjs';

const slug=z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),version=z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/);
export const honorRegistrySchema=z.strictObject({version:z.literal(1),rules:z.array(z.strictObject({ruleId:slug,ruleVersion:version,
  definitionHash:z.string().regex(/^[a-f0-9]{64}$/),revoked:z.boolean()})).max(8)});
const key=value=>`${value.ruleId}@${value.ruleVersion}`;
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function honorDefinition(input){
  const rule=honorRuleSchema.parse(input),definition=structuredClone({...rule,revoked:false});
  definition.members.sort(compare);
  definition.relatedPartyGroups=definition.relatedPartyGroups.map(group=>group.sort(compare))
    .sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));
  definition.repositories=definition.repositories.map(repository=>({owner:repository.owner.toLowerCase(),repository:repository.repository.toLowerCase()}))
    .sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));
  return {definition,definitionHash:digest(canonicalize(definition))};
}
export function honorRegistryManifest(rules){
  const result=honorRegistrySchema.parse({version:1,rules:rules.map(rule=>({ruleId:rule.id,ruleVersion:rule.version,
    definitionHash:honorDefinition(rule).definitionHash,revoked:rule.revoked??false}))});
  if(new Set(result.rules.map(key)).size!==result.rules.length)throw new Error('Duplicate Honor rule version');
  result.rules.sort((a,b)=>compare(key(a),key(b)));return result;
}
export async function storeHonorRuleVersions(db,{endpoint,runtimeEventId,rules}){
  for(const input of rules){const {definition,definitionHash}=honorDefinition(input);
    await db.query(`INSERT INTO honor_rule_versions(endpoint,rule_id,rule_version,definition_hash,definition,introduced_config_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(endpoint,rule_id,rule_version) DO NOTHING`,
      [endpoint,definition.id,definition.version,definitionHash,JSON.stringify(definition),runtimeEventId]);
    const prior=(await db.query('SELECT definition_hash FROM honor_rule_versions WHERE endpoint=$1 AND rule_id=$2 AND rule_version=$3',
      [endpoint,definition.id,definition.version])).rows[0];
    if(prior?.definition_hash!==definitionHash)throw new Error('Honor rule version conflict: publish a new version');
  }
}
export async function currentHonorRegistry(db,endpoint){
  const row=(await db.query("SELECT id,sequence,payload FROM runtime_config_events WHERE endpoint=$1 AND component='api' ORDER BY sequence DESC LIMIT 1",[endpoint])).rows[0];
  const parsed=honorRegistrySchema.safeParse(row?.payload.snapshot.honorRegistry);
  if(!parsed.success)throw new ServiceError('honor_registry_unavailable',503);
  return {configurationEventId:row.id,sequence:Number(row.sequence),observedAt:row.payload.observedAt,rules:parsed.data.rules};
}
export async function registryRule(db,endpoint,id,version,state,row){
  row??=(await db.query('SELECT * FROM honor_rule_versions WHERE endpoint=$1 AND rule_id=$2 AND rule_version=$3',[endpoint,id,version])).rows[0];
  if(!row)throw new ServiceError('honor_rule_unavailable',404);
  const checked=honorDefinition(row.definition);
  if(checked.definitionHash!==row.definition_hash)throw new ServiceError('honor_registry_inconsistent',503);
  const configured=state.rules.find(item=>item.ruleId===id&&item.ruleVersion===version);
  let observation=configured,observedConfig=state.configurationEventId;
  if(!observation){
    const previous=(await db.query(`SELECT id,payload FROM runtime_config_events WHERE endpoint=$1 AND component='api' AND sequence<=$2
      AND payload->'snapshot'->'honorRegistry'->'rules' @> $3::jsonb ORDER BY sequence DESC LIMIT 1`,
      [endpoint,state.sequence,JSON.stringify([{ruleId:id,ruleVersion:version}])])).rows[0];
    observation=previous?.payload.snapshot.honorRegistry.rules.find(item=>item.ruleId===id&&item.ruleVersion===version);observedConfig=previous?.id;
  }
  if(!observation||observation.definitionHash!==checked.definitionHash)throw new ServiceError('honor_registry_inconsistent',503);
  return {rule:{...checked.definition,revoked:observation.revoked},configured:Boolean(configured),registry:{version:1,
    definitionHash:checked.definitionHash,introducedConfigurationId:row.introduced_config_id,introducedAt:row.created_at,
    configurationEventId:state.configurationEventId,configurationSequence:state.sequence,lastMentionedConfigurationId:observedConfig,
    configured:Boolean(configured),revoked:observation.revoked,independentlyCertified:false}};
}
