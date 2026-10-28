process.stdin.setEncoding('utf8');
import {readFile} from 'node:fs/promises';
import {createIncidentController,incidentPolicySchema,assertIncidentTransition} from '../../packages/galaxy-official/src/operations/incident.mjs';
let stdin='';for await(const chunk of process.stdin)stdin+=chunk;const input=JSON.parse(stdin);
const result={observations:[],validations:[],transitions:[]};
for(const policy of input.policies){const c=createIncidentController(policy,{endpoint:input.endpoint,now:()=>input.now});result.observations.push({snapshot:c.snapshot(),policy:c.policy(),canProcessEvidence:c.canProcessEvidence(),routes:input.routes.map(r=>{try{c.assertRoute(r.method,r.path);return null}catch(e){return e.code}})});}
for(const policy of input.invalidPolicies)result.validations.push(incidentPolicySchema.safeParse(policy).success);
for(const [previous,next] of input.transitions){try{assertIncidentTransition(previous,next);result.transitions.push(null)}catch(e){result.transitions.push(e.message)}}
console.log(JSON.stringify(result));

