// Generate the conversation model's strategy schema from the actual shared Zod source.
// Go remains authoritative for custom refinements, authorization and CAS.
import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import {p13ConfigurationSchema} from '../packages/galaxy-contracts/src/p13-strategies-schema.mjs';

const original = z.toJSONSchema(p13ConfigurationSchema, {io: 'input', unrepresentable: 'any'});
const defs = original.$defs;
function inline(value, depth = 0) {
  if (Array.isArray(value)) return value.map(item => inline(item, depth)).filter(item => item !== null);
  if (!value || typeof value !== 'object') return value;
  if ('$ref' in value) {
    const match = /^#\/\$defs\/([^/]+)$/.exec(value.$ref);
    if (!match || !Object.hasOwn(defs, match[1])) throw new Error('Unsupported P13 schema reference');
    // A condition root is depth zero. A group at depth six cannot contain a
    // valid child at depth seven, so the sixth group is the deepest possible.
    if (depth >= 6) return null;
    return inline(defs[match[1]], depth + 1);
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$defs' || key === '$schema') continue;
    result[key] = inline(entry, depth);
  }
  return result;
}
const schema = inline(original);
schema.description = 'Shared P13 configuration shape. Cross-field rules, current authorization and version checks remain enforced by the service.';
await writeFile(new URL('../services/galaxy-operations-agentos/src/galaxy_agentos/p13_configuration_schema.json', import.meta.url), JSON.stringify(schema) + '\n');
