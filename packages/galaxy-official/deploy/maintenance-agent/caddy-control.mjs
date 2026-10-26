import {readFile,readlink,lstat,mkdir,writeFile,chown,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {noSymlinkPath} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const hash=x=>createHash('sha256').update(x).digest('hex');
const runtimeDirectory='/run/galaxy-maintenance-caddy',unitDirectory='/run/systemd/system/caddy.service.d';
const fields=text=>Object.fromEntries(text.trim().split('\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),line.slice(n+1)];}));
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);

// The deployed Caddy has `admin off`. Reuse that service and its actual fixed
// binary; never enable a management listener. Its original Caddyfile stays
// untouched. A single exact runtime systemd drop-in points it at an adapted,
// validated native JSON file until the approved operation opens the site.
export class MaintenanceCaddyControl{
 constructor({config,run,paths={},processMetadata=null}){
  Object.assign(this,{config,run,processMetadata});
  this.paths={configuration:'/etc/caddy/Caddyfile',runtime:runtimeDirectory,units:unitDirectory,...paths};
 }
 async metadata(){
  const raw=fields((await this.run(this.config.tools.systemctl,['show','caddy','--no-pager','--property=MainPID,ActiveState,User,Group,ExecStart'],{timeout:10000,maxOutput:32768})).stdout);
  if(raw.ActiveState!=='active'||!/^[1-9][0-9]*$/.test(raw.MainPID)||Number(raw.MainPID)<=1||raw.User!=='caddy'||raw.Group!=='caddy')throw fail('maintenance_current_caddy_service_unknown');
  const live=this.processMetadata?await this.processMetadata(raw.MainPID):await(async()=>{
   const status=await readFile('/proc/'+raw.MainPID+'/status','utf8'),uid=/^Uid:\s+([0-9]+)/m.exec(status),gid=/^Gid:\s+([0-9]+)/m.exec(status);
   return{executable:await readlink('/proc/'+raw.MainPID+'/exe'),command:(await readFile('/proc/'+raw.MainPID+'/cmdline','utf8')).split('\0').filter(Boolean),uid:Number(uid?.[1]),gid:Number(gid?.[1])};
  })();
  if(!/^\/opt\/galaxy\/runtime\/caddy-v[0-9.]+-linux-amd64\/caddy$/.test(live.executable)||!Number.isInteger(live.uid)||!Number.isInteger(live.gid)||live.uid<1||live.gid<1)throw fail('maintenance_current_caddy_service_unknown');
  const executable=await lstat(live.executable);if(!executable.isFile()||executable.isSymbolicLink()||executable.uid!==0||(executable.mode&0o022))throw fail('maintenance_current_caddy_service_unknown');
  return live;
 }
 async source(){
  await noSymlinkPath(this.paths.configuration);const info=await lstat(this.paths.configuration);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)||info.size>4*1024*1024)throw fail('maintenance_current_caddy_configuration_unknown');
  return hash(await readFile(this.paths.configuration));
 }
 async snapshot(){
  const live=await this.metadata(),command=[live.executable,'run','--config',this.paths.configuration,'--adapter','caddyfile'];
  if(canonical(live.command)!==canonical(command))throw fail('maintenance_current_caddy_service_unknown');
  const sourceDigest=await this.source(),raw=await this.run(live.executable,['adapt','--config',this.paths.configuration,'--adapter','caddyfile'],{timeout:30000,maxOutput:4*1024*1024});
  let configuration;try{configuration=JSON.parse(raw.stdout);}catch{throw fail('maintenance_current_caddy_configuration_unknown');}
  if(configuration.admin?.disabled!==true)throw fail('maintenance_current_caddy_admin_state_changed');
  return{configuration,source:{sourceDigest,executable:live.executable,uid:live.uid,gid:live.gid}};
 }
 files(operationId){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))throw fail('maintenance_operation_invalid');
  return{configuration:this.paths.runtime+'/'+operationId+'.json',override:this.paths.units+'/90-galaxy-maintenance.conf'};
 }
 override(source,file){return '[Service]\nExecStart=\nExecStart='+source.executable+' run --config '+file+'\n';}
 async load(configuration,{operationId,source}){
  const live=await this.metadata();if(live.executable!==source.executable||live.uid!==source.uid||live.gid!==source.gid||await this.source()!==source.sourceDigest)throw fail('maintenance_public_routes_changed');
  const files=this.files(operationId);for(const file of[files.configuration,files.override]){await noSymlinkPath(file);try{await lstat(file);throw fail('maintenance_caddy_runtime_override_exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
  await mkdir(this.paths.runtime,{recursive:true,mode:0o750});await chown(this.paths.runtime,0,source.gid);
  await writeFile(files.configuration,canonical(configuration)+'\n',{flag:'wx',mode:0o640});await chown(files.configuration,0,source.gid);
  await this.run(source.executable,['validate','--config',files.configuration],{timeout:30000,maxOutput:1024});
  await mkdir(this.paths.units,{recursive:true,mode:0o755});await writeFile(files.override,this.override(source,files.configuration),{flag:'wx',mode:0o644});
  await this.run(this.config.tools.systemctl,['daemon-reload'],{timeout:30000,maxOutput:1024});
  await this.run(this.config.tools.systemctl,['restart','caddy'],{timeout:90000,maxOutput:1024});
 }
 async current({operationId,source}){
  const files=this.files(operationId),live=await this.metadata();
  if(live.executable!==source.executable||live.uid!==source.uid||live.gid!==source.gid||canonical(live.command)!==canonical([source.executable,'run','--config',files.configuration])||await this.source()!==source.sourceDigest)throw fail('maintenance_public_routes_changed');
  for(const file of[files.configuration,files.override]){await noSymlinkPath(file);const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022))throw fail('maintenance_public_routes_changed');}
  if(await readFile(files.override,'utf8')!==this.override(source,files.configuration))throw fail('maintenance_public_routes_changed');
  return JSON.parse(await readFile(files.configuration,'utf8'));
 }
 async restore({operationId,source}){
  await this.current({operationId,source});const files=this.files(operationId);
  // Only this exact operation's two owned runtime files are removed. Current
  // source files, keys and permanent systemd configuration are never replaced.
  await unlink(files.override);await this.run(this.config.tools.systemctl,['daemon-reload'],{timeout:30000,maxOutput:1024});
  await this.run(this.config.tools.systemctl,['restart','caddy'],{timeout:90000,maxOutput:1024});
  const value=await this.snapshot();if(value.source.sourceDigest!==source.sourceDigest)throw fail('maintenance_public_activation_unknown');
  await unlink(files.configuration);return value.configuration;
 }
}
