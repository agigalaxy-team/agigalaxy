import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {noSymlinkPath} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const canonical=x=>JSON.stringify(x,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
const controlPaths=Object.freeze(['/admin/operations/maintenance','/admin/operations/maintenance/*','/admin/login','/admin/login/*','/_next/*','/v1/operations/maintenance/*','/v1/operations/session','/v1/operations/login','/v1/operations/callback','/v1/operations/logout']);
const unavailable={handler:'static_response',status_code:503,headers:{'Cache-Control':['no-store'],'Retry-After':['60']},body:'Galaxy maintenance in progress.'};

function identityRoutes(routes){
 return(routes??[]).flatMap(route=>{
  let identity=false;
  const handle=(route.handle??[]).flatMap(handler=>{
   if(handler.handler==='reverse_proxy'){const selected=handler.upstreams?.length&&handler.upstreams.every(u=>/^(?:127[.]0[.]0[.]1|localhost|\[::1\]):18080$/.test(u.dial??''));if(selected)identity=true;return selected?[handler]:[];}
   if(handler.handler==='subroute'){const inner=identityRoutes(handler.routes);if(inner.length)identity=true;return inner.length?[{...handler,routes:inner}]:[];}
   if(['headers','rewrite','vars','authentication','encode','request_body','log_append'].includes(handler.handler))return[handler];
   return[];
  });
  // Only the original host/path match and a current Keycloak upstream survive.
  // No path is granted identity access merely because its name looks like IAM.
  if(!identity)return[];
  if((route.handle??[]).some(h=>!['reverse_proxy','subroute','headers','rewrite','vars','authentication','encode','request_body','log_append'].includes(h.handler)))throw fail('maintenance_current_identity_route_unknown');
  return[{...route,handle}];
 });
}
export function containedPublicConfiguration(configuration,probeToken){
 const copy=structuredClone(configuration),servers=copy.apps?.http?.servers;
 if(!servers||!Object.keys(servers).length)throw fail('maintenance_public_routes_unknown');
 let identityCount=0;
 for(const server of Object.values(servers)){
  if(!Array.isArray(server.routes))throw fail('maintenance_public_routes_unknown');
  const original=server.routes,identity=identityRoutes(original);identityCount+=identity.length;
  server.routes=[...(probeToken?[{match:[{method:['GET'],path:['/','/readyz','/healthz','/admin/login'],header:{'X-Galaxy-Maintenance-Probe':[probeToken]}}],handle:[{handler:'subroute',routes:original}],terminal:true}]:[]),{match:[{path:[...controlPaths]}],handle:[{handler:'subroute',routes:original}],terminal:true},...identity,{handle:[unavailable],terminal:true}];
 }
 if(!identityCount)throw fail('maintenance_current_identity_route_unknown');
 return copy;
}

export class MaintenancePublicGate{
 constructor({controlDirectory,fetchImpl=fetch,control=null}){Object.assign(this,{controlDirectory,fetchImpl,control});}
 async request(path,body){
  const response=await this.fetchImpl('http://127.0.0.1:2019'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw fail('maintenance_public_gate_failed');const value=await response.text();if(Buffer.byteLength(value)>4*1024*1024)throw fail('maintenance_public_gate_response_limit');
  return value.trim()?JSON.parse(value):null;
 }
 async contain(operationId){
  if(!/^[a-f0-9-]{36}$/.test(operationId))throw fail('maintenance_operation_invalid');
  const snapshot=this.control?await this.control.snapshot():null,original=snapshot?snapshot.configuration:await this.request('/config/'),probeToken=randomBytes(32).toString('hex'),contained=containedPublicConfiguration(original,probeToken),directory=this.controlDirectory+'/public-gates';
  await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});
  const file=directory+'/'+operationId+'.json',record={version:1,operationId,original,probeToken,containedDigest:digest(contained),...(snapshot?{source:snapshot.source}:{} )};
  await writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});
  // A lost load ACK keeps the site contained/unknown; no automatic opening.
  if(this.control)await this.control.load(contained,record);else await this.request('/load',contained);
  if(digest(this.control?await this.control.current(record):await this.request('/config/'))!==record.containedDigest)throw fail('maintenance_public_containment_unconfirmed');
  return{version:1,operationId,artifactPath:file,containedDigest:record.containedDigest,probeToken,publicActivation:false};
 }
 async open(contribution){
  const file=this.controlDirectory+'/public-gates/'+contribution.operationId+'.json';
  if(file!==contribution.artifactPath)throw fail('maintenance_public_gate_invalid');await noSymlinkPath(file);
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>4*1024*1024)throw fail('maintenance_private_public_gate_required');
  const record=JSON.parse(await readFile(file,'utf8'));
  if(record.operationId!==contribution.operationId||record.containedDigest!==contribution.containedDigest||digest(this.control?await this.control.current(record):await this.request('/config/'))!==record.containedDigest)throw fail('maintenance_public_routes_changed');
  const after=this.control?await this.control.restore(record):await(async()=>{await this.request('/load',record.original);return this.request('/config/');})();
  if(digest(after)!==digest(record.original))throw fail('maintenance_public_activation_unknown');
  return{publicActivation:true};
 }
}
