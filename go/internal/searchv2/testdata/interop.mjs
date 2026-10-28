import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {searchV2QuerySchema,searchV2ReferenceSchema} from '../../../../packages/galaxy-official/src/shared/search-v2-schema.mjs';
import {generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const [mode,path]=process.argv.slice(2);if(!isAbsolute(path??'')||!['history-fixture.json','ci-fixture.json'].includes(basename(path)))throw Error('disposable fixture required');let input='';for await(const b of process.stdin)input+=b;input=JSON.parse(input||'null');
const db=new pg.Pool({connectionString:address.href,max:8});try{
 if(mode==='schema'){console.log(JSON.stringify({values:input.map(({reference,value})=>{const p=(reference?searchV2ReferenceSchema:searchV2QuerySchema).safeParse(value);return p.success?{value:p.data}:{error:true}})}));}
 else if(mode==='read'){
  const f=JSON.parse(await readFile(path,'utf8')),key=generateKeyPairSync('ed25519'),s=createServices({db,endpoint:f.endpoint,now:()=>f.clock,trustedKeys:new Map(f.pins),kid:'unused',signingKey:key.privateKey,allowedScopes:['binding','consent','case-teaser','evidence','proof','history'],operator:'Isolated source query',region:'test'});s.cases.configurations=null;const results=[];
  for(const q of input){try{const type=q.kind==='reference'?q.input.search.type:q.input.type,scope=type==='proof'?'proof':type==='task'?'assistance':type==='capsule'?'capsules':['worker','hub'].includes(type)?'builders':'history',actor=q.actor?await s.access.authenticate(f.owner.token,scope):null,value=await s.search.v2[q.kind](actor,q.input);results.push({value})}catch(e){results.push({error:e.code??'internal_error',status:e.status??500})}}console.log(JSON.stringify({results}));
 }else throw Error('mode');
}finally{await db.end()}
