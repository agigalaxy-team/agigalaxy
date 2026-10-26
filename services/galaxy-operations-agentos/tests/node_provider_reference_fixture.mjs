// Local fixture only: actual Node envelope/bind/ledger, synthetic authorization.
import http from 'node:http';
import {createRequire,registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

const repo=process.env.GALAXY_NODE_REPO??resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const source=join(repo,'packages/galaxy-official/src');
const dependencyRoot=process.env.GALAXY_NODE_DEPENDENCY_ROOT??repo;
const require=createRequire(join(dependencyRoot,'packages/galaxy-official/package.json'));
let resolvingDependency=false;
registerHooks({resolve(specifier,context,next){
 try{return next(specifier,context);}catch(error){
  if(resolvingDependency||specifier.startsWith('.')||specifier.startsWith('/')||specifier.includes(':'))throw error;
  try{resolvingDependency=true;return{url:pathToFileURL(require.resolve(specifier)).href,shortCircuit:true};}
  finally{resolvingDependency=false;}
 }
}});
const {PGlite}=require('@electric-sql/pglite');
const {AgentOsConversationTools}=await import(pathToFileURL(join(source,'operations/agentos/conversation-tools.mjs')));
const {operationsToolCallIdSchema}=await import(pathToFileURL(join(source,'shared/operations-tool-call-id.mjs')));
const db=new PGlite();
await db.exec(`CREATE TABLE operations_agentos_conversation_commands_v1(endpoint TEXT,id UUID,conversation_id UUID,operator_id UUID,state TEXT,native_run_id TEXT,result JSONB,PRIMARY KEY(endpoint,id));
 CREATE TABLE operations_agentos_conversation_tool_calls_v1(id UUID PRIMARY KEY,endpoint TEXT,conversation_id UUID,turn_id UUID,native_run_id TEXT,call_id TEXT,tool TEXT,arguments_digest TEXT,state TEXT,metadata JSONB,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,UNIQUE(endpoint,conversation_id,native_run_id,call_id));`);
const endpoint='explicit-local-fixture',operatorId=randomUUID(),contexts=new Map();
const service=Object.create(AgentOsConversationTools.prototype);
Object.assign(service,{db,endpoint,now:()=>Math.floor(Date.now()/1000),conversations:{
 current:async id=>({row:{id,session_id:contexts.get(id),domain:'overview'},actor:{operatorId,endpoint}}),
 boundedTaskWithin:async()=>{},
 summaryFor:async()=>({state:'available',basis:'explicit-local-fixture',effectExecuted:false})
}});
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/inspection'){
   const result=await db.query('SELECT native_run_id,call_id,length(call_id)AS id_length,state FROM operations_agentos_conversation_tool_calls_v1 ORDER BY created_at,id');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({rows:result.rows,maxLength:Math.max(0,...result.rows.map(row=>row.id_length)),indexContract:'UNIQUE(endpoint,conversation_id,native_run_id,call_id)'}));return;
  }
  if(req.method!=='POST'||req.url!=='/tools/execute'||req.headers.authorization!=='Bearer explicit-local-synthetic-key')throw Error('local-fixture-route');
  let input='';for await(const part of req){input+=part;if(input.length>1000000)throw Error('local-fixture-bound');}
  const x=JSON.parse(input);
  if(!operationsToolCallIdSchema.safeParse(x.callId).success)throw Error('local-fixture-call-reference');
  contexts.set(x.conversationId,x.sessionId);
  await db.query("INSERT INTO operations_agentos_conversation_commands_v1(endpoint,id,conversation_id,operator_id,state)VALUES($1,$2,$3,$4,'accepted')ON CONFLICT DO NOTHING",[endpoint,x.turnId,x.conversationId,operatorId]);
  const result=await service.execute(x);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'explicit-local-fixture-rejected'}));}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,contractSha256:createHash('sha256').update(readFileSync(join(source,'shared/operations-tool-call-id.mjs'))).digest('hex')})));
process.on('SIGTERM',()=>{server.close();db.close().finally(()=>process.exit());});
