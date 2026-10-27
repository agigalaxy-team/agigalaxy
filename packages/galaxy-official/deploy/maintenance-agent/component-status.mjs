import {maintenanceComponents} from "../../src/operations/maintenance/catalog.mjs";

// Read existing process/monitor samples only. This adapter never joins the
// backup footprint, starts a probe, reads logs, or changes a capture writer.
const scrapeAgeSeconds=90; // Existing external.rules.json stale boundary.
const dockerName=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const containerFormat='{"name":{{json .Name}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"healthCheckedAt":{{$last := ""}}{{if .State.Health}}{{range .State.Health.Log}}{{$last = .End}}{{end}}{{end}}{{json $last}}}';
const nonFootprintContainers=new Set(['api','worker','publisher','admin','website','prometheus','business-db','accounts-db','loki','log-collector']);
const available=()=>({state:'available',code:null});
const unavailable=code=>({state:'unavailable',code});
const notConfigured=code=>({state:'not-configured',code});
const date=value=>{const ms=Date.parse(value);return Number.isFinite(ms)?ms:null;};
const fresh=(at,now)=>at!==null&&at<=now&&now-at<=scrapeAgeSeconds*1000;
const sampleMilliseconds=value=>{const seconds=typeof value==='string'&&value.trim()?Number(value):NaN,ms=seconds*1000;return Number.isFinite(ms)&&Number.isFinite(new Date(ms).getTime())?ms:null;};

function empty(id){return{id,processState:'unknown',processBasis:'not-connected',processAvailability:notConfigured('maintenance_component_not_bound'),
 health:'unknown',healthBasis:'not-connected',healthAvailability:notConfigured('maintenance_health_not_connected'),checkedAt:null,processCheckedAt:null,healthCheckedAt:null,code:null};}
function processFact(row,state,basis,availability,at){Object.assign(row,{processState:state,processBasis:basis,processAvailability:availability,processCheckedAt:at,checkedAt:at,code:availability.code});}
function healthFact(row,state,basis,availability,at=null){Object.assign(row,{health:state,healthBasis:basis,healthAvailability:availability,healthCheckedAt:at});if(at)row.checkedAt=at;}
function sourceFailure(row,basis,code){processFact(row,'unknown',basis,unavailable(code),null);healthFact(row,'unknown','not-connected',unavailable(code));}

function footprintProcesses(rows,footprint,at){
 for(const [kind,basis]of[['services','systemd-process'],['containers','container-process']]){
  for(const source of Array.isArray(footprint?.[kind])?footprint[kind]:[]){
   const row=rows.get(source.id);if(!row)continue;
   if(source.state==='available'&&typeof source.active==='boolean')processFact(row,source.active?'running':'stopped',basis,available(),at);
   else sourceFailure(row,basis,'maintenance_component_process_unavailable');
  }
 }
}

async function additionalProcesses(config,rows,{footprint,run,now}){
 const requests=[];
 const existing=Array.isArray(footprint?.containers)?footprint.containers:[];
 for(const id of rows.keys()){
  if(nonFootprintContainers.has(id))continue;
  const matches=existing.filter(source=>source.id===id);
  if(matches.length>1){sourceFailure(rows.get(id),'container-process','maintenance_component_binding_invalid');continue;}
  if(matches[0]?.state!=='available')continue;
  if(dockerName.test(matches[0].name??''))requests.push({id,name:matches[0].name});
  else sourceFailure(rows.get(id),'container-process','maintenance_component_binding_invalid');
 }
 for(const [id,stanza]of[['business-db','business'],['accounts-db','accounts']]){
  const matches=(Array.isArray(config.postgres)?config.postgres:[]).filter(row=>row.id===stanza);
  if(matches.length===1&&dockerName.test(matches[0].container??''))requests.push({id,name:matches[0].container});
  else if(matches.length)sourceFailure(rows.get(id),'container-process','maintenance_component_binding_invalid');
 }
 if(dockerName.test(config.projectName??''))for(const [id,suffix]of[['loki','-loki'],['log-collector','-alloy']]){
  const name=config.projectName+suffix;if(dockerName.test(name))requests.push({id,name});else sourceFailure(rows.get(id),'container-process','maintenance_component_binding_invalid');
 }
 const containers=(async()=>{
  if(!requests.length)return;
  try{
   const names=[...new Set(requests.map(row=>row.name))];
   const output=await run(config.tools.docker,['inspect','--format',containerFormat,...names],{accepted:[0,1],timeout:5000,maxOutput:65536});
   const text=typeof output?.stdout==='string'?output.stdout:'';if(Buffer.byteLength(text)>65536)throw Error('invalid');
   const values=text.trim()?text.trim().split('\n').map(line=>JSON.parse(line)):[];
   if(values.length>names.length||values.some(value=>typeof value?.name!=='string'||!names.includes(value.name.replace(/^\//,''))))throw Error('invalid');
   const observed=now(),at=observed.toISOString();
   for(const request of requests){
    const row=rows.get(request.id),matches=values.filter(value=>value.name.replace(/^\//,'')===request.name);
    if(matches.length!==1){sourceFailure(row,'container-process','maintenance_component_process_unavailable');continue;}
    const value=matches[0],state=value.status==='running'?'running':['created','exited'].includes(value.status)?'stopped':value.status==='dead'?'failed':'unknown';
    if(!['created','running','paused','restarting','removing','exited','dead'].includes(value.status)||value.health!==null&&!['healthy','unhealthy','starting'].includes(value.health)){
     sourceFailure(row,'container-process','maintenance_component_response_invalid');continue;
    }
    processFact(row,state,'container-process',available(),at);
    const checkedAt=typeof value.healthCheckedAt==='string'?date(value.healthCheckedAt):null;
    if(state!=='running'&&value.health!==null)healthFact(row,'unknown','container-healthcheck',unavailable('maintenance_health_process_not_running'));
    else if(value.health==='healthy'||value.health==='unhealthy'){
     if(checkedAt===null||checkedAt>observed.getTime())healthFact(row,'unknown','container-healthcheck',unavailable('maintenance_health_sample_missing'));
     else healthFact(row,value.health,'container-healthcheck',available(),new Date(checkedAt).toISOString());
    }else if(value.health==='starting')healthFact(row,'unknown','container-healthcheck',available());
   }
  }catch{for(const request of requests)sourceFailure(rows.get(request.id),'container-process','maintenance_component_process_unavailable');}
 })();
 const prometheus=(async()=>{
  const row=rows.get('prometheus');
  // Existing mode can point at a separately managed collector. Do not guess
  // its unit name or call that absence a stopped process.
  if(config.monitoring?.mode!=='managed')return;
  try{
   const result=await run(config.tools.systemctl,['show','galaxy-prometheus.service','--no-pager','--property=LoadState,ActiveState'],{timeout:5000,maxOutput:4096});
   if(typeof result?.stdout!=='string'||Buffer.byteLength(result.stdout)>4096)throw Error('invalid');
   const fields={};for(const line of result.stdout.trim().split('\n')){const i=line.indexOf('=');const key=line.slice(0,i);if(i<0||!['LoadState','ActiveState'].includes(key)||Object.hasOwn(fields,key))throw Error('invalid');fields[key]=line.slice(i+1);}
   if(fields.LoadState!=='loaded'){sourceFailure(row,'systemd-process','maintenance_component_unit_unavailable');return;}
   const state=fields.ActiveState==='active'?'running':fields.ActiveState==='failed'?'failed':fields.ActiveState==='inactive'?'stopped':'unknown';
   processFact(row,state,'systemd-process',available(),now().toISOString());
  }catch{sourceFailure(row,'systemd-process','maintenance_component_process_unavailable');}
 })();
 await Promise.all([containers,prometheus]);
}

async function jsonRead(fetchImpl,url){
 try{
  const response=await fetchImpl(url,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
  if(!response.ok)return{value:null,code:'maintenance_health_read_failed'};
  // Bound bytes before JSON parsing. Do not retain arbitrary upstream errors.
  if(!response.body)return{value:null,code:'maintenance_health_response_invalid'};
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>262144){await reader.cancel();return{value:null,code:'maintenance_health_response_invalid'};}parts.push(item.value);}}
  finally{reader.releaseLock();}
  return{value:JSON.parse(Buffer.concat(parts).toString('utf8')),code:null};
 }catch{return{value:null,code:'maintenance_health_read_failed'};}
}
function vector(result,job,instance){
 const value=result.value;if(result.code)return{items:null,code:result.code};
 if(value?.status!=='success'||value.data?.resultType!=='vector'||!Array.isArray(value.data.result)||value.data.result.length>4)return{items:null,code:'maintenance_health_response_invalid'};
 if(value.data.result.some(row=>row?.metric?.job!==job||row.metric.instance!==instance||!Array.isArray(row.value)||row.value.length!==2))return{items:null,code:'maintenance_health_response_invalid'};
 return{items:value.data.result,code:null};
}
function oneMetric(items,name){const rows=items.filter(row=>row.metric.__name__===name);return rows.length===1&&['0','1'].includes(rows[0].value[1])?Number(rows[0].value[1]):null;}

async function monitoringHealth(config,rows,{fetchImpl,now}){
 let base;
 if(!config.monitoring?.prometheusUrl)return;
 try{base=new URL(config.monitoring.prometheusUrl);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.search||base.hash)throw Error('invalid');}
 catch{for(const id of ['api','worker','website'])healthFact(rows.get(id),'unknown',id==='website'?'prometheus-probe':'prometheus-target',unavailable('maintenance_component_binding_invalid'));return;}
 const url=path=>new URL(base.href.replace(/\/$/,'')+path);
 const site=config.monitoring?.website;
 const configuredSite=typeof site==='string'&&(()=>{try{const u=new URL(site);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}})();
 const selector=configuredSite?'{__name__=~"up|probe_success",job="galaxy-external-website",instance='+JSON.stringify(site)+'}':null;
 const query=expression=>{const target=url('/api/v1/query');target.searchParams.set('query',expression);return jsonRead(fetchImpl,target);};
 const [targets,samples,sampleTime,upTime]=await Promise.all([
  jsonRead(fetchImpl,url('/api/v1/targets?state=active')),
  selector?query(selector):null,
  selector?query('timestamp(probe_success{job="galaxy-external-website",instance='+JSON.stringify(site)+'})'):null,
  selector?query('timestamp(up{job="galaxy-external-website",instance='+JSON.stringify(site)+'})'):null,
 ]);
 const observed=now(),time=observed.getTime();
 const targetRows=targets.value?.status==='success'&&Array.isArray(targets.value.data?.activeTargets)&&targets.value.data.activeTargets.length<=4096?targets.value.data.activeTargets:null;
 for(const [id,job,key]of[['api','galaxy-api','apiTarget'],['worker','galaxy-worker','workerTarget']]){
  const expected=config.monitoring?.[key],row=rows.get(id);if(!expected)continue;
  if(!targetRows){healthFact(row,'unknown','prometheus-target',unavailable(targets.code??'maintenance_health_response_invalid'));continue;}
  const matches=targetRows.filter(value=>value.labels?.job===job&&value.labels?.instance===expected);
  if(matches.length!==1){healthFact(row,'unknown','prometheus-target',unavailable(matches.length?'maintenance_health_source_ambiguous':'maintenance_health_sample_missing'));continue;}
  const source=matches[0],at=date(source.lastScrape);
  if(!fresh(at,time)){healthFact(row,'unknown','prometheus-target',unavailable('maintenance_health_sample_stale'),at===null?null:new Date(at).toISOString());continue;}
  if(!['up','down'].includes(source.health)){healthFact(row,'unknown','prometheus-target',unavailable('maintenance_health_response_invalid'));continue;}
  healthFact(row,source.health==='up'?'healthy':'unhealthy','prometheus-target',available(),new Date(at).toISOString());
 }
 if(!configuredSite)return;
 const row=rows.get('website'),values=vector(samples,'galaxy-external-website',site),times=vector(sampleTime,'galaxy-external-website',site),upTimes=vector(upTime,'galaxy-external-website',site);
 if(values.code||times.code||upTimes.code){healthFact(row,'unknown','prometheus-probe',unavailable(values.code??times.code??upTimes.code));return;}
 const up=oneMetric(values.items,'up'),success=oneMetric(values.items,'probe_success');
 if(up===null){healthFact(row,'unknown','prometheus-probe',unavailable(values.items.length?'maintenance_health_response_invalid':'maintenance_health_sample_missing'));return;}
 const upAt=upTimes.items.length===1?sampleMilliseconds(upTimes.items[0].value[1]):null;
 if(!fresh(upAt,time)){healthFact(row,'unknown','prometheus-probe',unavailable('maintenance_health_sample_stale'),upAt===null?null:new Date(upAt).toISOString());return;}
 if(up===0){healthFact(row,'unknown','prometheus-probe',unavailable('maintenance_health_scrape_failed'));return;}
 if(success===null||times.items.length!==1){healthFact(row,'unknown','prometheus-probe',unavailable('maintenance_health_sample_missing'));return;}
 const at=sampleMilliseconds(times.items[0].value[1]);
 if(!fresh(at,time)){healthFact(row,'unknown','prometheus-probe',unavailable('maintenance_health_sample_stale'),at===null?null:new Date(at).toISOString());return;}
 healthFact(row,success===1?'healthy':'unhealthy','prometheus-probe',available(),new Date(at).toISOString());
}

export async function readMaintenanceComponentStatus(config,{footprint,run,fetchImpl=fetch,now=()=>new Date()}={}){
 const rows=new Map(maintenanceComponents.map(({id})=>[id,empty(id)])),at=now().toISOString();
 footprintProcesses(rows,footprint,at);
 const websiteUnit=config.monitoring?.websiteUnit;
 if(websiteUnit){
  try{
   if(!/^[a-zA-Z0-9_.@-]+\.service$/.test(websiteUnit))throw Error('Invalid website unit');
   const observed=await run(config.tools.systemctl,['show',websiteUnit,'--property=ActiveState','--value'],{accepted:[0],timeout:5000,maxOutput:1024});
   const active=observed.stdout.trim();if(!['active','inactive','failed','activating','deactivating'].includes(active))throw Error('Unknown website state');
   processFact(rows.get('website'),active==='active'?'running':'stopped','systemd-process',available(),at);
  }catch{sourceFailure(rows.get('website'),'systemd-process','maintenance_component_process_unavailable');}
 }else processFact(rows.get('website'),'unknown','not-connected',notConfigured('maintenance_component_not_bound'),null);
 await Promise.all([additionalProcesses(config,rows,{footprint,run,now}),monitoringHealth(config,rows,{fetchImpl,now})]);
 return maintenanceComponents.map(({id})=>rows.get(id));
}
