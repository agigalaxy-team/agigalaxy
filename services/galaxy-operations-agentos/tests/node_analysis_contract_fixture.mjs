import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=process.env.GALAXY_NODE_REPO??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {agentOsQueryArgumentsSchema:schema}=await import(pathToFileURL(path.join(repo,'packages/galaxy-contracts/src/operations-agentos-query-schema.mjs')));
const rows=[
 ['accounts','summary',[7,28]],['content','list',[7,28,'all']],['feedback','list',[7,28,'all']],
 ['recommendations','overview',[7,30,90]],['search','overview',[7,30,90]],
 ...['overview','business','retention','paths','account'].map(view=>['analytics',view,Array.from({length:90},(_,n)=>n+1)])
];
let validChecks=0;
const defaultDays=[];
for(const[module,view,days]of rows){
 const extra=view==='account'?{accountId:'00000000-0000-4000-8000-000000000001'}:{};
 for(const day of days){assert(schema.safeParse({module,view,filters:{days:day,...extra}}).success);validChecks++;}
 for(const day of [0,91,true])assert(!schema.safeParse({module,view,filters:{days:day,...extra}}).success);
 const defaultQuery=schema.parse({module,view,filters:extra}); // actual published schema default
 defaultDays.push({module,view,days:defaultQuery.filters.days});
}
assert(!schema.safeParse({module:'recommendations',view:'history',filters:{days:7}}).success);
console.log(JSON.stringify({windowRoutes:rows.length,validDayChecks:validChecks,defaultDays,sharedDefaultsUnchanged:true,providerCalled:false,productionCalled:false}));
