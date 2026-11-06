import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';

// Gorse 0.5.11 logs the supplied/configured API keys on failed native auth.
// Its port must remain on the private Docker network. Only this closed proxy
// can reach it; wrong client credentials are rejected before the native hop.
const credential=name=>{const value=process.env[name];if(!value||value.length<32||/[\r\n]/.test(value))throw new Error(name+' must be explicitly configured');return value;};
const callerKey=credential('GALAXY_GORSE_GATEWAY_KEY');
const nativeKey=credential('GALAXY_GORSE_NATIVE_KEY');
const upstream=new URL(process.env.GORSE_UPSTREAM??'http://gorse:8088');
if(upstream.username||upstream.password||upstream.protocol!=='http:'||upstream.pathname!=='/')throw new Error('Invalid private Gorse origin');
function authorized(value){if(typeof value!=='string')return false;const a=Buffer.from(value),b=Buffer.from(callerKey);return a.length===b.length&&timingSafeEqual(a,b);}
function allowed(method,url){
 if(url.hash||url.username||url.password)return false;
 const p=url.pathname;
 if(method==='GET'&&p==='/api/health/ready')return !url.search;
 if(method==='POST'&&['/api/user','/api/items'].includes(p)||method==='PUT'&&p==='/api/feedback')return !url.search;
 if(method==='DELETE'&&/^\/api\/item\/(post|reply)_[0-9a-f-]{36}$/.test(p))return !url.search;
 if(method==='DELETE'&&/^\/api\/feedback\/(view|click|bookmark|participate|not-interested|like)\/(account|visitor)%3A[0-9a-f-]{36}\/(post|reply)_[0-9a-f-]{36}$/i.test(p))return !url.search;
 if(method==='GET'&&(p==='/api/latest'||/^\/api\/recommend\/(account|visitor)%3A[0-9a-f-]{36}$/i.test(p))){
  const parameters=[...url.searchParams];
  if(new Set(parameters.map(([key])=>key)).size!==parameters.length)return false;
  return parameters.every(([key,value])=>key==='n'&&/^[1-9]\d{0,2}$/.test(value)&&Number(value)<=100
   ||key==='offset'&&/^(0|[1-9]\d{0,2})$/.test(value)&&Number(value)<=100
   ||key==='category'&&/^(technology|arts|learning|life|galaxy|unclassified)$/.test(value));
 }
 return false;
}
// A caller can time out before the native request finishes. Keep later changes
// to the same real feedback behind that native request, even if its caller has
// disconnected. This also orders ordinary event feedback of the same type.
const feedbackTails=new Map();
function feedbackKeys(method,url,body){
 if(method==='DELETE'&&url.pathname.startsWith('/api/feedback/')){
  const [, , ,type,user,item]=url.pathname.split('/');
  return [JSON.stringify([decodeURIComponent(type),decodeURIComponent(user),decodeURIComponent(item)])];
 }
 if(method==='PUT'&&url.pathname==='/api/feedback'){
  const values=JSON.parse(body.toString('utf8'));
  if(!Array.isArray(values)||values.some(value=>!value||['FeedbackType','UserId','ItemId'].some(key=>typeof value[key]!=='string')))throw new Error('Invalid feedback');
  return [...new Set(values.map(value=>JSON.stringify([value.FeedbackType,value.UserId,value.ItemId])))];
 }
 return [];
}
async function serializeFeedback(keys,action){
 if(!keys.length)return action();
 const prior=keys.map(key=>feedbackTails.get(key)).filter(Boolean);
 let release;const tail=new Promise(resolve=>{release=resolve;});
 for(const key of keys)feedbackTails.set(key,tail);
 await Promise.all(prior);
 try{return await action();}finally{release();for(const key of keys)if(feedbackTails.get(key)===tail)feedbackTails.delete(key);}
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 const fail=(status,code)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:code}));}else res.destroy();};
 if(!authorized(req.headers['x-api-key']))return fail(401,'gorse_gateway_unauthorized');
 const url=new URL(req.url,'http://gateway');
 if(!allowed(req.method,url))return fail(404,'gorse_gateway_route_denied');
 const controller=new AbortController();
 req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort();});
 try{
  let body;
  if(['POST','PUT'].includes(req.method)){
   if(req.headers['content-type']?.split(';')[0]!=='application/json')return fail(415,'gorse_gateway_json_required');
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)return fail(413,'gorse_gateway_request_too_large');chunks.push(chunk);}body=Buffer.concat(chunks);
  }
  let keys;try{keys=feedbackKeys(req.method,url,body);}catch{return fail(400,'gorse_gateway_feedback_invalid');}
  await serializeFeedback(keys,async()=>{
   if(controller.signal.aborted)return;
   const signal=keys.length?AbortSignal.timeout(15000):AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
   const response=await fetch(new URL(url.pathname+url.search,upstream),{method:req.method,headers:{'X-API-Key':nativeKey,...(body?{'Content-Type':'application/json'}:{})},body,redirect:'error',signal});
   // Drain the original native response before releasing the relation, even
   // when there is no caller left to receive it.
   if(!response.ok){await response.arrayBuffer();return fail(response.status>=500?503:502,'gorse_native_request_failed');}
   if(!res.destroyed)res.writeHead(response.status,{'Content-Type':'application/json'});
   for await(const chunk of response.body??[])if(!res.destroyed)res.write(chunk);
   if(!res.destroyed)res.end();
  });
 }catch{fail(503,'gorse_native_unavailable');}
});
server.listen(Number(process.env.PORT??8080),'0.0.0.0',()=>console.info('Galaxy Gorse gateway listening; private upstream; closed routes'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
