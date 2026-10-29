// Explicit loopback transport double for Python's SDK/gateway reference tests.
// Current Go conversation tests own authority, durable bind and ledger replay.
import http from 'node:http';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const repo=process.env.GALAXY_NODE_REPO??resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const contract=join(repo,'packages/galaxy-contracts/src/operations-tool-call-id.mjs');
const {operationsToolCallIdSchema}=await import(pathToFileURL(contract));
const calls=[];
const boundary='current-shared-call-id-schema; durable-ledger-owned-by-Go';
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/inspection'){
   const rows=calls.map(x=>({native_run_id:x.runId,call_id:x.callId,id_length:x.callId.length,state:'transport-observed'}));
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({rows,maxLength:Math.max(0,...rows.map(row=>row.id_length)),boundary}));return;
  }
  if(req.method!=='POST'||req.url!=='/tools/execute'||req.headers.authorization!=='Bearer explicit-local-synthetic-key')throw Error('local-fixture-route');
  let input='';for await(const part of req){input+=part;if(input.length>1000000)throw Error('local-fixture-bound');}
  const x=JSON.parse(input);
  if(!operationsToolCallIdSchema.safeParse(x.callId).success)throw Error('local-fixture-call-reference');
  calls.push({conversationId:x.conversationId,sessionId:x.sessionId,turnId:x.turnId,runId:x.runId,callId:x.callId});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({state:'available',basis:'explicit-current-contract-transport-fixture',effectExecuted:false}));
 }catch{
  res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'explicit-local-fixture-rejected'}));
 }
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,contractSha256:createHash('sha256').update(readFileSync(contract)).digest('hex')})));
process.on('SIGTERM',()=>server.close(()=>process.exit()));
