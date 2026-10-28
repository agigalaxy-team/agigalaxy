// Original Native/OIDC/room services, disposable loopback PostgreSQL. The only
// transport stand-in supplies local delivery/edit receipts, never source ACLs.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import canonicalize from '../../packages/galaxy-official/node_modules/canonicalize/lib/canonicalize.js';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
import {communityForumFixture} from '../../packages/galaxy-official/test/community-forum-fixture.mjs';
import {invite} from '../../packages/galaxy-official/test/chat-workflow.mjs';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import * as schemas from '../../packages/galaxy-official/src/shared/personal-summary-schema.mjs';
if(process.argv[2]==='schema'){const inputs=JSON.parse(await readFile(process.argv[3],'utf8')),names={'preferences/save':'summaryPreferenceSchema',put:'summaryPutSchema',list:'summaryPageSchema',receipt:'summaryReceiptSchema'};console.log(JSON.stringify(inputs.map(x=>{let parsed;try{parsed=schemas[names[x.action]].parse(JSON.parse(x.raw))}catch{return{accepted:false}}const result={accepted:true,json:JSON.stringify(parsed)};if(x.action==='put'){const{preferenceRevision,...intent}=parsed;try{result.hash=digest(canonicalize(intent))}catch{result.hashError=true}}return result})));process.exit(0);}
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated PostgreSQL required');
const dir=process.env.GALAXY_GO_TEST_SUMMARIES_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable directory required');
const pool=new pg.Pool({connectionString:address.href,max:4}),endpoint='https://summaries.example.invalid';let f,bridge;
try{
 await migrate(pool,{roles:['api']});f=await communityForumFixture({database:pool,migrateDatabase:false,endpoint});await f.login(f.owner,'summary-owner');await f.login(f.responder,'summary-author');
 let failEdit=false;const transport={available:true,project:async()=>{},send:async x=>({archiveId:x.messageId}),edit:async x=>{if(failEdit)throw Error('isolated transport edit outcome unknown');return{revision:x.expectedRevision+1}}};f.owner.chat.transport=transport;
 const roomId=randomUUID();await f.owner.chat.create(f.owner.actor,{roomId,operationId:randomUUID(),title:'Explicit summary source room'});await invite(f.owner.chat,f.owner.actor,roomId,f.responder.actor);
 const sent=await f.owner.chat.send(f.responder.actor,roomId,{clientMessageId:randomUUID(),text:'Original selected message, not a summary model input'}),edit={operationId:randomUUID(),expectedRevision:1,text:'Author corrected current message'};
 const summaryId=randomUUID(),ref={messageId:sent.messageId,revision:1},base={versionId:randomUUID(),summaryId,roomId,baseRevision:0,preferenceRevision:1,content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'90071992547409930000',complete:true},fragments:[{id:randomUUID(),kind:'derived',text:'Owner-selected derived fragment',sourceRefs:[ref]},{id:randomUUID(),kind:'personal-note',text:'Independent owner note',sourceRefs:[]}],keyMessageRefs:[ref]}},conflict={...base,versionId:randomUUID(),content:{...base.content,generator:{kind:'user-model',label:'Owner-selected existing model output'}}},resolve={...base,versionId:randomUUID(),baseRevision:1,resolveVersionIds:[conflict.versionId]};
 bridge=createServer(async(req,res)=>{try{if(req.method!=='POST'||req.url!=='/fixture'){res.writeHead(404);res.end();return};const chunks=[];for await(const c of req)chunks.push(c);const x=JSON.parse(Buffer.concat(chunks).toString());let result;
  if(x.action==='preferences')result=await f.owner.summaries.preferences(f.owner.actor);
  else if(x.action==='get')result=await f.owner.summaries.get(x.other?f.responder.actor:f.owner.actor,x.input);
  else if(x.action==='get-rollback'){const db=await pool.connect();try{await db.query('BEGIN');await db.query('SET LOCAL ROLE galaxy_api');result=await f.owner.summaries.getWithin(db,f.owner.actor,x.input.summaryId);await db.query('ROLLBACK')}finally{db.release()}}
  else if(x.action==='purge-invalid-rollback'){const db=await pool.connect(),original=f.owner.summaries.db;try{f.owner.summaries.db={connect:async()=>({query:async(sql,args)=>{if(sql==='COMMIT')return db.query('ROLLBACK');if(sql==='BEGIN'){await db.query(sql);return db.query('SET LOCAL ROLE galaxy_api')};return db.query(sql,args)},release(){}})};result=await f.owner.summaries.purgeInvalidSources(x.input??{});}finally{f.owner.summaries.db=original;await db.query('ROLLBACK');db.release()}}
  else if(x.action==='put')result=await f.owner.summaries.put(f.owner.actor,x.input);
  else if(x.action==='receipt')result=await f.owner.summaries.receipt(x.other?f.responder.actor:f.owner.actor,x.input);
  else if(x.action==='list')result=await f.owner.summaries.list(f.owner.actor,x.input);
  else if(x.action==='sources')result=await f.owner.summaries.sources(f.owner.actor,x.input);
  else if(x.action==='pending-edit'){failEdit=true;try{await f.owner.chat.edit(f.responder.actor,roomId,sent.messageId,edit);throw Error('expected original transport failure')}catch(e){if(e.message!=='isolated transport edit outcome unknown')throw e};result={pending:true};}
  else if(x.action==='complete-edit'){failEdit=false;result=await f.owner.chat.edit(f.responder.actor,roomId,sent.messageId,edit);}
  else throw Error('unknown original action');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(e.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.code??e.message}));}});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));await writeFile(join(dir,'fixture.json'),JSON.stringify({endpoint,now:f.clock.now,issuer:f.issuer.issuer,token:f.owner.credential,otherToken:f.responder.credential,roomId,summaryId,source:{roomId,refs:[ref]},preference:{expectedRevision:0,endpoint,enabled:true},puts:[base,conflict,resolve],bridge:`http://127.0.0.1:${bridge.address().port}/fixture`}),{mode:0o600});console.log('ready');await new Promise(resolve=>process.stdin.once('data',resolve));
}finally{if(bridge){bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve))};if(f)await f.close();await pool.end()}
