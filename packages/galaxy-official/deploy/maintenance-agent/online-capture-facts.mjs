import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {inspectPostgres,postgresSqlArguments} from '../operations-stack/host.mjs';

const intersects=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const releasePath=/^(?:\/opt\/galaxy\/releases|\/srv\/galaxy\/admin\/releases)\/[A-Za-z0-9._-]+$/;
export async function immutableReleaseSourceIds(sources,services,containers,{fs={lstat}}={}){
 const ids=[];
 for(const source of sources){
  if(!['api-release','admin-release'].includes(source.id)||source.kind!=='tree'||!releasePath.test(source.path))continue;
  const users=services.filter(row=>row.releasePaths.includes(source.path));
  if(!users.length||users.some(row=>!row.immutableReleasePaths?.includes(source.path)))continue;
  if(containers.some(row=>row.state==='available'&&row.mounts.some(m=>m.writable&&intersects(source.path,m.path))))continue;
  const info=await fs.lstat(source.path);if(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&!(info.mode&0o022))ids.push(source.id);
 }
 return ids.sort();
}
export function serviceImmutableReleasePaths(fields,paths){
 // A versioned pathname alone is not an immutability guarantee. Application
 // namespaces must enforce read-only code; caches/media remain separate sources.
 if(fields.ProtectSystem!=='strict'||!fields.User||fields.User==='root'||fields.User==='0'||fields.BindPaths||fields.TemporaryFileSystem||fields.RootDirectory||fields.RootImage)return[];
 const writable=(fields.ReadWritePaths??'').trim().split(/\s+/).filter(Boolean).map(path=>path.replace(/^-/,''));
 if(writable.some(path=>!path.startsWith('/')||posix.normalize(path)!==path||/[\p{Cc}\\]/u.test(path)))return[];
 return paths.filter(path=>releasePath.test(path)&&!writable.some(root=>intersects(path,root)));
}

const unavailable=reason=>({state:'unavailable',stanza:null,database:null,reason});
const flagsTemplate='{{range .Config.Env}}{{$key := index (split . "=") 0}}{{if or (eq $key "KC_DB") (eq $key "KC_DB_URL") (eq $key "KC_TRANSACTION_XA_ENABLED") (eq $key "JAVA_OPTS_KC_HEAP")}}{{println (json .)}}{{else}}{{println (json $key)}}{{end}}{{end}}';
const commandTemplate='{{range .Config.Cmd}}{{$key := index (split . "=") 0}}{{if eq . "start"}}start\n{{else if eq . "--import-realm"}}read-only-import\n{{else if eq . "start-dev"}}start-dev\n{{else if and (ge (len .) 2) (eq (slice . 0 2) "-D")}}jvm-property\n{{else if eq $key "--optimized"}}optimized\n{{else if eq $key "--config-file"}}custom-config\n{{else if eq $key "--cache-config-file"}}custom-cache\n{{else if eq $key "--transaction-xa-enabled"}}{{if eq . "--transaction-xa-enabled=false"}}xa-false\n{{else}}xa-unknown\n{{end}}{{else if or (eq $key "--db") (and (ge (len $key) 5) (eq (slice $key 0 5) "--db-"))}}database-override\n{{else}}unknown\n{{end}}{{end}}';
function pureHeapOptions(value){
 if(typeof value!=='string'||value.length>1024||/[\p{Cc}]/u.test(value))return null;
 const tokens=value.trim().split(/ +/),keys=[];
 if(!tokens.length||tokens.length>5)return null;
 for(const token of tokens){
  const size=/^-(Xms|Xmx)([1-9][0-9]{0,8})[kKmMgG]$/.exec(token),percent=/^-XX:(InitialRAMPercentage|MinRAMPercentage|MaxRAMPercentage)=([0-9]{1,3}(?:[.][0-9]{1,3})?)$/.exec(token);
  const key=size?.[1]??percent?.[1];
  if(!key||keys.includes(key)||percent&&Number(percent[2])>100)return null;
  keys.push(key);
 }
 return keys.sort();
}
const configXaProbe='while IFS= read -r line; do if [[ "$line" =~ ^[[:space:]]*transaction-xa-enabled[[:space:]]*=[[:space:]]*(true|false)[[:space:]]*$ ]]; then printf "%s\\n" "${BASH_REMATCH[1]}"; elif [[ "$line" =~ ^[[:space:]]*(transaction-xa-enabled|db-kind-[a-zA-Z0-9_-]+|cache-config-file)[[:space:]]*= ]]; then printf "unrecognized\\n"; fi; done < /opt/keycloak/conf/keycloak.conf';
export async function keycloakOnlinePostgresBinding(config,row,{run}={}){
 if(!row||row.id!=='keycloak'||row.state!=='available'||row.unprovenMounts!==false||row.mounts.some(m=>m.writable))return unavailable('persistent-mount-not-read-only');
 if(row.mounts.some(m=>!/^\/opt\/keycloak\/(?:themes(?:\/[A-Za-z0-9._-]+)?|providers\/galaxy-email-code-26[.]7[.]3[.]jar|data\/import\/[A-Za-z0-9._-]+[.]json)$/.test(m.target)))return unavailable('custom-persistence-binding');
 if(!row.active)return unavailable('component-not-running');
 try{
  const inspect=async format=>(await run(config.tools.docker,['inspect','--format',format,row.name],{timeout:5000,maxOutput:16384})).stdout;
  const version=JSON.parse(await inspect('{{json (index .Config.Labels "org.opencontainers.image.version")}}'));
  // This fallback is only proven for the deployed engine. Unknown versions,
  // optimized builds or custom persistence retain the original cold capture.
  if(version!=='26.7.3')return unavailable('engine-version-not-proven');
  if((await inspect('{{if and (eq (len .Config.Entrypoint) 1) (eq (index .Config.Entrypoint 0) "/opt/keycloak/bin/kc.sh")}}standard{{else}}custom{{end}}')).trim()!=='standard')return unavailable('startup-mode-not-proven');
  const envLines=(await inspect(flagsTemplate)).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),settings=new Map();
  for(const line of envLines){if(typeof line!=='string'||/[\p{Cc}]/u.test(line))return unavailable('configuration-ambiguous');const at=line.indexOf('=');if(at<0){if(/^(?:JAVA_(?:OPTS|ADD_OPENS|LOCALE|TOOL_OPTIONS)|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|KC_(?:DB_KIND_|DB_SCHEMA|DB_URL_|TRANSACTION_XA_ENABLED_|CACHE_CONFIG_FILE|CONFIG_))/.test(line))return unavailable('custom-persistence-binding');continue;}const key=line.slice(0,at);if(!['KC_DB','KC_DB_URL','KC_TRANSACTION_XA_ENABLED','JAVA_OPTS_KC_HEAP'].includes(key)||settings.has(key))return unavailable('configuration-ambiguous');settings.set(key,line.slice(at+1));}
  const heapKeys=settings.has('JAVA_OPTS_KC_HEAP')?pureHeapOptions(settings.get('JAVA_OPTS_KC_HEAP')):[];
  if(heapKeys===null)return unavailable('jvm-heap-not-proven');
  if(settings.get('KC_DB')!=='postgres'||!['false',undefined].includes(settings.get('KC_TRANSACTION_XA_ENABLED')))return unavailable('database-or-xa-not-proven');
  const command=(await inspect(commandTemplate)).trim().split('\n').filter(Boolean);
  if(!command.includes('start')||new Set(command).size!==command.length||command.some(x=>!['start','xa-false','read-only-import'].includes(x)))return unavailable('startup-mode-not-proven');
  if(command.includes('read-only-import')&&!row.mounts.some(m=>!m.writable&&/^\/opt\/keycloak\/data\/import\/[A-Za-z0-9._-]+[.]json$/.test(m.target)))return unavailable('read-only-import-not-proven');
  const xa=(await run(config.tools.docker,['exec',row.name,'/bin/bash','-c',configXaProbe],{timeout:5000,maxOutput:1024})).stdout.trim();
  if(xa&&xa!=='false')return unavailable('xa-or-custom-persistence-not-proven');
  const url=new URL((settings.get('KC_DB_URL')??'').replace(/^jdbc:/,'')),database=decodeURIComponent(url.pathname.slice(1));
  if(url.protocol!=='postgresql:'||url.search||url.hash||!/^[_a-z0-9-]{1,63}$/.test(database))return unavailable('database-target-not-proven');
  const matches=[];
  for(const pg of config.postgres.filter(pg=>pg.id==='accounts')){
   const bindings=JSON.parse((await run(config.tools.docker,['inspect','--format','{"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}}}',pg.container],{timeout:5000,maxOutput:16384})).stdout),port=url.port||'5432';
   const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&(bindings.ports?.['5432/tcp']??[]).some(x=>['127.0.0.1','::1'].includes(x.HostIp)&&x.HostPort===port);
   const network=port==='5432'&&Object.values(bindings.networks??{}).some(x=>[x.IPAddress,x.GlobalIPv6Address,...(x.Aliases??[])].includes(url.hostname));
   if(local||network)matches.push(pg);
  }
  if(matches.length!==1)return unavailable('database-stanza-not-proven');
  const pg=matches[0],current=await inspectPostgres(config,pg,run);if(current.archiveMode!=='on'||!pg.systemIdentifier||current.systemIdentifier!==pg.systemIdentifier)return unavailable('online-archive-not-proven');
  const query="SELECT json_build_object('primary',NOT pg_is_in_recovery(),'realm',to_regclass('public.realm') IS NOT NULL,'users',to_regclass('public.user_entity') IS NOT NULL,'sessions',to_regclass('public.offline_user_session') IS NOT NULL,'externalUserStores',(SELECT count(*) FROM public.component WHERE provider_type='org.keycloak.storage.UserStorageProvider'))";
  const fact=JSON.parse((await run(config.tools.docker,postgresSqlArguments({...pg,database},query),{timeout:10000,maxOutput:8192})).stdout.trim());
  if(fact.primary!==true||fact.realm!==true||fact.users!==true||fact.sessions!==true||Number(fact.externalUserStores)!==0)return unavailable('persistent-store-not-proven');
  // Bind only non-secret proof facts. Never hash or return the raw JDBC URL,
  // username, password, unrelated environment or configuration contents.
  const proofDigest=createHash('sha256').update(JSON.stringify({version,entrypoint:'standard',command,heapParameterKeys:heapKeys,xaEnvironment:settings.get('KC_TRANSACTION_XA_ENABLED')??null,xaDefaultConfiguration:xa||null,databaseKind:'postgres',host:url.hostname,port:url.port||'5432',database,systemIdentifier:current.systemIdentifier,archiveMode:current.archiveMode})).digest('hex');
  return{state:'available',stanza:pg.id,database,proofDigest,reason:null};
 }catch{return unavailable('online-binding-unavailable');}
}
