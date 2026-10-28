// Development/test extraction of the retained closed audit DTO field catalog.
// The runtime consumes embedded descriptors, never JavaScript. The original two
// custom refinements (file version tuple and year-zero day) remain explicit Go.
import {readFile} from 'node:fs/promises';
const sourceURL=new URL('../../../../packages/galaxy-official/src/operations/audit/view.mjs',import.meta.url),
 zodURL=new URL('../../../../packages/galaxy-official/node_modules/zod/index.js',import.meta.url);
const {z}=await import(zodURL.href);
let source=await readFile(sourceURL,'utf8');
source=source.replace("from 'zod'",'from '+JSON.stringify(zodURL.href))
 .replace('from "./attribution.mjs"','from '+JSON.stringify(new URL('./attribution.mjs',sourceURL).href))
 .replace('const shapes=new Map();','export const shapes=new Map();');
const {shapes}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const output={types:[],actions:{}},ids=new Map();
function strip(value){if(Array.isArray(value))return value.map(strip);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='$schema').map(([k,v])=>[k,strip(v)]));return value;}
for(const[action,entry]of shapes){output.actions[action]={};for(const side of ['selection','result']){const fields={};for(const[key,schema]of Object.entries(entry[side])){const description=strip(z.toJSONSchema(schema,{io:'input',unrepresentable:'any'})),wire=JSON.stringify(description);if(!ids.has(wire)){ids.set(wire,output.types.length);output.types.push(description);}fields[key]=ids.get(wire);}output.actions[action][side]=fields;}}
const {businessAuditAttributionSchema,businessAuditActorContextSchema}=await import(new URL('./attribution.mjs',sourceURL).href);
output.attribution=strip(z.toJSONSchema(businessAuditAttributionSchema,{io:'input',unrepresentable:'any'}));
output.actorContext=strip(z.toJSONSchema(businessAuditActorContextSchema,{io:'input',unrepresentable:'any'}));
process.stdout.write(JSON.stringify(output));
