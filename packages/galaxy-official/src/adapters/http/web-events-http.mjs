import {ServiceError} from '../../shared/service-error.mjs';

export async function dispatchWebEvents({webEvents,request,response,requestId,url,send}){
 const admin=url.pathname==='/v1/operations/web-events';
 if(!admin&&url.pathname!=='/v1/web-events')return false;
 if(request.method!=='GET')throw new ServiceError('not_found',404);
 if(!webEvents)throw new ServiceError('web_events_unavailable',503);
 for(const key of url.searchParams.keys())if(!['cursor','topics','stream'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_web_events_request',400);
 const cursor=url.searchParams.get('cursor')??request.headers['last-event-id']??null;
 if(cursor!==null&&(typeof cursor!=='string'||!/^(0|[1-9]\d{0,18})$/.test(cursor)))throw new ServiceError('invalid_web_events_cursor',400);
 const topics=url.searchParams.has('topics')?url.searchParams.get('topics').split(','):undefined;
 const connection=await webEvents.connect({request,requestId,surface:admin?'admin':'web',topics});
 response.setHeader('Cache-Control','private, no-store');response.setHeader('X-Content-Type-Options','nosniff');
 if(url.searchParams.get('stream')==='false'){const events=await webEvents.read(connection,cursor);send(200,{cursor:events.at(-1).cursor,modules:connection.modules,events});return true;}
 if(url.searchParams.has('stream')&&url.searchParams.get('stream')!=='true')throw new ServiceError('invalid_web_events_request',400);
 let current=cursor,closed=false,busy=false,pending=false,ready=false;
 const close=()=>{if(closed)return;closed=true;clearInterval(timer);unsubscribe?.();response.end();};
 const pump=async()=>{
  if(closed)return;if(busy){pending=true;return;}busy=true;
  try{
   const events=await webEvents.read(connection,current);
   if(closed)return;
   for(const event of events){
    if(response.writableLength>65536){close();return;}
    response.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);current=event.cursor;
   }
  }catch{
   // Clear only this connection's module projections; no source locator leaks.
   if(!closed)response.write(`data: ${JSON.stringify({type:'reset',cursor:current??'0',modules:connection.modules})}\n\n`);
   close();
  }finally{busy=false;if(pending){pending=false;void pump();}}
 };
 // Subscribe before snapshot to close the snapshot/listen race.
 const unsubscribe=await webEvents.subscribe(()=>{if(ready)void pump();else pending=true;});
 response.statusCode=200;response.setHeader('Content-Type','text/event-stream; charset=utf-8');response.setHeader('X-Accel-Buffering','no');response.flushHeaders?.();
 ready=true;request.once('aborted',close);response.once('close',close);
 // This is session/expiry reauthorization, not a periodic query refetch.
 const timer=setInterval(()=>void pump(),15000);timer.unref?.();
 await pump();return true;
}
