export function createV2SessionAdapter(context) {
 const listeners=new Set();
 const mappedMessages=sessionID=>context.data.session.message.list(sessionID).filter(m=>m.type==='user'||m.type==='assistant').map(m=>({id:m.id,sessionID,role:m.type,time:m.time,model:m.model,providerID:m.model?.providerID,modelID:m.model?.modelID??m.model?.id,agent:m.agent,finish:m.finish,error:m.error,v2Original:m}));
 const route={get current(){const r=context.ui.router.current();return r.type==='session'?{name:'session',params:{sessionID:r.sessionID}}:{name:r.type};},navigate(name,params){if(name==='session'&&typeof params?.sessionID==='string')context.ui.router.navigate({type:'session',sessionID:params.sessionID});else if(name==='home')context.ui.router.navigate({type:'home'});}};
 const state={session:{get:id=>context.data.session.get(id),messages:mappedMessages,status:id=>({type:context.data.session.status(id)})},part:()=>[],mcp:()=>context.data.location.mcp.server.list(context.location)??[]};
 const event={on(type,handler){const stop=context.data.listen(({details})=>{const data=details.data??{};const id=data.sessionID;if(!id)return;let mapped;
  if(details.type==='session.execution.succeeded')mapped='session.idle';else if(details.type==='session.execution.failed'||details.type==='session.execution.interrupted')mapped='session.error';else if(details.type.startsWith('session.'))mapped='message.updated';
  if(mapped===type)handler({type,properties:{sessionID:id}});
 });listeners.add(stop);return()=>{if(listeners.delete(stop))stop();};}};
 const syncMessages=async (sessionID,{signal}={})=>{const result=[];let cursor;do{const page=await context.client.message.list(cursor?{sessionID,limit:200,cursor}:{sessionID,limit:200,order:'asc'},{signal});if(!Array.isArray(page.data))throw Error('host_messages_unavailable');result.push(...page.data);cursor=page.cursor?.next??undefined;}while(cursor);return result;};
 const client={session:{async message({sessionID,messageID}){const raw=(await syncMessages(sessionID)).find(message=>message.id===messageID);if(!raw)return {error:'host_original_unavailable'};const parts=raw.type==='user'?[{type:'text',text:raw.text}]:raw.type==='assistant'?(raw.content??[]).filter(part=>part.type==='text').map(part=>({type:'text',text:part.text})):[];return {data:{parts}};}}};
 const v2={syncMessages};
 return {route,state,event,client,v2,closeData(){for(const stop of listeners)stop();listeners.clear();}};
}
