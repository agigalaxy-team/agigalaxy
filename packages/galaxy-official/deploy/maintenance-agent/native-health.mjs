import {readFile,lstat} from 'node:fs/promises';
import {MeilisearchClient,GorseClient,OpenPanelClient} from '../../src/discovery-runtime/native-clients.mjs';
import {postgresSqlArguments} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const serviceUnits={api:'galaxy-api@pilot.service',admin:'galaxy-admin-pilot.service',worker:'galaxy-worker@pilot.service',publisher:'galaxy-content-publisher-pilot.service'};
export class MaintenanceNativeHealth{
 constructor({config,run,fetchImpl=fetch}){Object.assign(this,{config,run,fetchImpl});}
 async json(url,headers={}){
  const response=await this.fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw fail('maintenance_module_health_not_ready');
  const text=await response.text();if(Buffer.byteLength(text)>1024*1024)throw fail('maintenance_native_response_limit');try{return JSON.parse(text);}catch{throw fail('maintenance_module_health_not_ready');}
 }
 async discovery(){
  const path='/var/lib/galaxy/config/pilot/discovery-api-20261023.json',info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o007)||info.size>262144)throw fail('maintenance_private_discovery_reference_invalid');
  const value=JSON.parse(await readFile(path,'utf8'));return value;
 }
 async service(id){
  const unit=serviceUnits[id];if(!unit)throw fail('maintenance_service_health_not_registered');
  const result=await this.run(this.config.tools.systemctl,['show',unit,'--no-pager','--property=ActiveState,EnvironmentFiles'],{timeout:10000,maxOutput:8192});
  const rows=Object.fromEntries(result.stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
  if(rows.ActiveState!=='active')throw fail('maintenance_module_health_not_ready');
  if(id==='api')return this.json('http://127.0.0.1:3201/readyz',{'Host':'official.agigalaxy.org','X-Forwarded-For':'127.0.0.1'});
  if(id==='admin'){
   const ports=[];
   for(const path of(rows.EnvironmentFiles??'').match(/\/etc\/galaxy\/[A-Za-z0-9._/-]+/g)??[]){
    const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw fail('maintenance_runtime_reference_invalid');
    for(const line of(await readFile(path,'utf8')).split(/\r?\n/)){const match=/^PORT=([1-9][0-9]{3,4})$/.exec(line);if(match&&Number(match[1])<=65535)ports.push(Number(match[1]));}
   }
   if(new Set(ports).size!==1)throw fail('maintenance_admin_listener_unknown');
   const response=await this.fetchImpl('http://127.0.0.1:'+ports[0]+'/admin/login',{redirect:'manual',signal:AbortSignal.timeout(10000)});if(response.status!==200)throw fail('maintenance_module_health_not_ready');return{ready:true};
  }
  // Worker/publisher process checks are separate from queue/database checks.
  // The public overview continues to label process-only health as unknown.
  return{processRunning:true};
 }
 async container(binding){
  const value=JSON.parse((await this.run(this.config.tools.docker,['inspect','--format','{"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}',binding.name],{timeout:10000,maxOutput:4096})).stdout);
  if(value.running!==true||value.health&&value.health!=='healthy')throw fail('maintenance_module_health_not_ready');
  if(value.health==='healthy')return{ready:true,basis:'native-container-healthcheck'};
  const args={
   chat:['prosodyctl','--config','/etc/prosody/prosody.cfg.lua','status'],objects:['/garage','status'],
   scanner:['clamdscan','--ping=1'],
   'analytics-db':['pg_isready','--username','openpanel','--dbname','openpanel'],
   'recommendation-db':['pg_isready','--username','gorse','--dbname','gorse'],
   'analytics-cache':['redis-cli','PING'],'recommendation-cache':['redis-cli','PING'],
   'analytics-events':['clickhouse-client','--query','SELECT 1'],
  }[binding.id];
  if(args){const response=await this.run(this.config.tools.docker,['exec',binding.name,...args],{timeout:15000,maxOutput:8192});if(['analytics-cache','recommendation-cache'].includes(binding.id)&&response.stdout.trim()!=='PONG')throw fail('maintenance_module_health_not_ready');return{ready:true,basis:'native-component-command'};}
  if(binding.id==='agentos'){const body=await this.json('http://127.0.0.1:3350/health');if(body.state!=='running'||body.persistence!=='native-database')throw fail('maintenance_module_health_not_ready');return{ready:true,basis:'native-health-route'};}
  if(binding.id==='analytics-api'||binding.id==='analytics-worker'){const x=await this.discovery();await new OpenPanelClient({...x.openpanel,fetch:this.fetchImpl}).health();return{ready:true,basis:binding.id==='analytics-api'?'native-health-route':'native-api-dependency-health-and-worker-process'};}
  if(binding.id==='search'){const x=await this.discovery();await new MeilisearchClient({...x.meilisearch,fetch:this.fetchImpl}).health();return{ready:true,basis:'native-health-route'};}
  if(binding.id==='recommendation'){const x=await this.discovery();await new GorseClient({...x.gorse,fetch:this.fetchImpl}).health();return{ready:true,basis:'native-health-route'};}
  if(binding.id==='grafana'){const value=await this.json('http://127.0.0.1:'+this.config.grafana.port+'/api/health');if(value.database!=='ok')throw fail('maintenance_module_health_not_ready');return{ready:true,basis:'native-health-route'};}
  if(binding.id==='model-gateway'){
   // Empty models are healthy configuration, not a failed component. This
   // check reads only the native process, never invokes a model/provider.
   const info=await lstat('/etc/galaxy/model-gateway/runtime.env');if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw fail('maintenance_private_native_key_required');
   const rows=(await readFile('/etc/galaxy/model-gateway/runtime.env','utf8')).split(/\r?\n/).filter(line=>line.startsWith('GALAXY_MODEL_GATEWAY_SERVICE_KEY='));if(rows.length!==1)throw fail('maintenance_current_native_key_unknown');
   await this.json('http://127.0.0.1:3351/galaxy/status',{authorization:'Bearer '+rows[0].slice('GALAXY_MODEL_GATEWAY_SERVICE_KEY='.length)});return{ready:true,basis:'native-empty-or-configured-model-status'};
  }
  throw fail('maintenance_component_health_not_connected');
 }
 async check(context){
  const selected=new Set(context.intent.moduleIds),checks={};
  for(const source of context.footprint.services)if(context.containment?.activeWriters.some(x=>x.kind==='systemd'&&x.name===source.unit))checks[source.id]=await this.service(source.id);
  for(const source of context.footprint.containers)if(source.state==='available'&&source.active&&(selected.has(source.module)||['keycloak'].includes(source.id)))if(source.id!=='keycloak')checks[source.id]=await this.container(source);
  const issuer=await this.json(this.config.grafana.issuer+'/.well-known/openid-configuration');if(issuer.issuer!==this.config.grafana.issuer)throw fail('maintenance_current_identity_not_ready');
  for(const cluster of this.config.postgres){const row=(await this.run(this.config.tools.docker,postgresSqlArguments(cluster,'SELECT 1'),{timeout:15000,maxOutput:1024})).stdout.trim();if(row!=='1')throw fail('maintenance_database_consistency_unconfirmed');}
  const headers=context.containment.probeToken?{'x-galaxy-maintenance-probe':context.containment.probeToken}:{};
  const api=await this.json(this.config.monitoring.readiness,headers);if(api.status!=='ready')throw fail('maintenance_public_readiness_unconfirmed');
  const website=await this.fetchImpl(this.config.monitoring.website,{headers,redirect:'manual',signal:AbortSignal.timeout(10000)});if(website.status!==200)throw fail('maintenance_public_readiness_unconfirmed');
  return{checks,currentIdentityReady:true,publicRoutesProbedWhileContained:true,codeExecutionOnly:true};
 }
}
