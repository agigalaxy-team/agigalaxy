import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../../src/infrastructure/database.mjs';
import {createWebEventService} from '../../src/web-events/service.mjs';
import {createApi} from '../../src/http.mjs';
import {requestUrl} from '../../src/adapters/http/policy.mjs';

async function openStream(url,origin){
 const controller=new AbortController();
 const response=await fetch(url,{headers:{Origin:origin,Accept:'text/event-stream'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);
 assert.equal(response.headers.get('access-control-allow-origin'),origin);
 const reader=response.body.getReader(),frames=[];let failure,buffer='';
 const consume=(async()=>{const decoder=new TextDecoder();try{
  while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});
   let end;while((end=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+2);
    const data=raw.split('\n').find(line=>line.startsWith('data: '));if(data)frames.push(JSON.parse(data.slice(6)));}}
 }catch(error){if(!controller.signal.aborted)failure=error;}})();
 return{frames,async until(predicate){const end=Date.now()+5000;while(Date.now()<end){if(failure)throw failure;const found=frames.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Expected HTTP SSE frame did not arrive');},
  async close(){controller.abort();await reader.cancel().catch(()=>{});await consume;}};
}

test('real PostgreSQL and createApi HTTP: legal CORS, shared SSE LISTEN, commit delivery and original-cursor replay',async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const pool=new pg.Pool({max:8,statement_timeout:10000});
 const endpoint='https://http-events.invalid',origin='https://website-events.invalid';
 let api,events,first,second,reconnected,tx;
 try{
  await migrate(pool);events=createWebEventService({pool,endpoint});await events.start();
  const version='a'.repeat(64),leasePath='/v1/operations/permissions/catalog/lease?version='+version;
  assert.equal(requestUrl({method:'GET',url:leasePath,headers:{origin}},endpoint,[origin]).searchParams.get('version'),version,'An exact catalog lease version passes HTTP policy to its dispatcher');
  assert.equal(requestUrl({method:'OPTIONS',url:leasePath,headers:{origin,'access-control-request-method':'GET'}},endpoint,[origin]).pathname,'/v1/operations/permissions/catalog/lease');
  assert.throws(()=>requestUrl({method:'GET',url:leasePath+'&version='+version,headers:{origin}},endpoint,[origin]),{code:'invalid_request'});
  api=createApi({bindings:{endpoint},webEvents:events,browserOrigins:[origin],rateLimit:100});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${api.address().port}/v1/web-events?topics=site-content`;
  const preflight=await fetch(base,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'Accept, Last-Event-ID'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.match(preflight.headers.get('access-control-allow-headers'),/Last-Event-ID/i);
  first=await openStream(base,origin);second=await openStream(base,origin);
  await Promise.all([first.until(frame=>frame.type==='snapshot'),second.until(frame=>frame.type==='snapshot')]);
  const listeners=async()=>Number((await pool.query("SELECT count(*) AS count FROM pg_stat_activity WHERE query='LISTEN galaxy_web_event_ready_v1' AND state='idle'")).rows[0].count);
  assert.equal(await listeners(),1,'Two real Node HTTP streams share one PG listener');
  tx=await pool.connect();await tx.query('BEGIN');
  const publicationId=randomUUID();
  await tx.query("INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,created_at,updated_at) VALUES($1,$2,'synthetic',$3,'queued',now(),now())",[publicationId,endpoint,JSON.stringify({privateDraft:'MUST_NOT_ENTER_SSE'})]);
  await tx.query("UPDATE site_publications_v1 SET state='published',published_at=now(),result=$2 WHERE id=$1",[publicationId,JSON.stringify({publicationId,siteVersion:'synthetic-one',publicUrl:origin+'/'})]);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(first.frames.filter(frame=>frame.type==='change').length,0,'A staged transaction cannot emit a business hint');
  assert.equal(second.frames.filter(frame=>frame.type==='change').length,0);
  await tx.query('COMMIT');tx.release();tx=null;
  const [sentA,sentB]=await Promise.all([first.until(frame=>frame.type==='change'&&frame.objectId===publicationId),second.until(frame=>frame.type==='change'&&frame.objectId===publicationId)]);
  assert.equal(sentA.module,'site-content');assert.equal(sentA.cursor,sentB.cursor);
  assert.ok(!JSON.stringify(first.frames).includes('MUST_NOT_ENTER_SSE'));
  const originalCursor=sentA.cursor;await first.close();first=null;
  assert.equal(await listeners(),1,'The other browser keeps the same shared listener');
  const nextId=randomUUID();
  await pool.query("INSERT INTO site_publications_v1(id,endpoint,requested_by,snapshot,state,published_at,result,created_at,updated_at) VALUES($1,$2,'synthetic','{}','published',now(),$3,now(),now())",[nextId,endpoint,JSON.stringify({publicationId:nextId,siteVersion:'synthetic-two',publicUrl:origin+'/'})]);
  const live=await second.until(frame=>frame.type==='change'&&frame.objectId===nextId);
  reconnected=await openStream(base+'&cursor='+originalCursor,origin);
  const replay=await reconnected.until(frame=>frame.type==='change'&&frame.objectId===nextId);
  assert.equal(replay.cursor,live.cursor,'Reconnect replays the original committed event cursor');
  assert.ok(!reconnected.frames.some(frame=>frame.type==='reset'),'An in-range cursor uses replay, not a module-wide reset');
 }finally{
  if(tx){await tx.query('ROLLBACK').catch(()=>{});tx.release();}
  await Promise.allSettled([first?.close(),second?.close(),reconnected?.close()]);
  events?.stop();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
  await pool.end();
 }
});
