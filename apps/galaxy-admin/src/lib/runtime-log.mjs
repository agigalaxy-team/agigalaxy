import {randomUUID} from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token=/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;
export function safeDiagnostic(error){
  if(!error||typeof error!=='object')return {errorName:'UnknownError'};
  const errorName=token.test(error.name)?error.name:'Error';
  const errorCode=typeof error.code==='string'&&/^(?:[A-Z][A-Z0-9_]{0,31}|[a-z][a-z0-9_]{0,63})$/.test(error.code)?error.code:undefined;
  // Never retain Error.message, SQL, arbitrary object fields, or stack arguments.
  const frames=typeof error.stack==='string'?error.stack.split('\n').slice(1,16).flatMap(line=>{
    const match=line.match(/(?:[\\/])([a-zA-Z0-9_.-]+\.(?:mjs|cjs|js|ts|tsx)):(\d+):(\d+)\)?$/);
    return match?[{file:match[1],line:Number(match[2]),column:Number(match[3])}]:[];
  }).slice(0,8):[];
  return {errorName,...(errorCode?{errorCode}:{}),...(frames.length?{frames}:{} )};
}
export function routeTemplate(value){
  let path;try{path=new URL(value,'http://localhost').pathname;}catch{return '/invalid';}
  const parts=path.split('/').filter(Boolean);
  const fixed=new Set(['v1','operations','users','content','publications','chat-reports','jobs','information-watch','search-recovery','content-publication','search','failures','session','login','logout','callback','retry','cancel','status','api','site','export','operators','site-pages','media','globals','site-settings','versions','access','me','preferences']);
  return '/'+parts.slice(0,12).map(part=>fixed.has(part)?part:':id').join('/');
}
export function requestCorrelation(headers){
  const candidate=headers?.get('x-galaxy-edge-request-id');
  return uuid.test(candidate??'')?candidate:randomUUID();
}
export function adminLog(event,values={},sink=line=>process.stdout.write(line)){
  const row={timestamp:new Date().toISOString(),level:values.statusCode>=500||values.error?'error':values.statusCode>=400?'warn':'info',component:'galaxy-admin',environment:process.env.GALAXY_ENVIRONMENT??'pilot',release:process.env.GALAXY_ADMIN_RELEASE??'0.1.2',event:token.test(event)?event:'runtime_event_rejected'};
  for(const key of ['stage','action','method'])if(typeof values[key]==='string'&&token.test(values[key]))row[key]=values[key];
  if(typeof values.path==='string')row.route=routeTemplate(values.path);
  for(const key of ['requestId','edgeRequestId'])if(uuid.test(values[key]??''))row[key]=values[key];
  for(const key of ['statusCode','durationMs'])if(Number.isFinite(values[key])&&values[key]>=0)row[key]=Math.round(values[key]*1000)/1000;
  if(values.error)Object.assign(row,safeDiagnostic(values.error));
  sink(JSON.stringify(row)+'\n');return row;
}
export function payloadLoggerOptions(){
  return {level:'info',base:{component:'galaxy-admin',environment:process.env.GALAXY_ENVIRONMENT??'pilot',release:process.env.GALAXY_ADMIN_RELEASE??'0.1.2'},
    formatters:{log(value){return {event:'cms.runtime',...(value.err?{diagnostic:safeDiagnostic(value.err)}:{})};}},
    // Payload can supply arbitrary user data as message arguments. Preserve the
    // error type and source frames above while keeping that free text private.
    hooks:{logMethod(args,method){const value=args.find(item=>item&&typeof item==='object');method.call(this,value??{},'cms.runtime');}},
    serializers:{err:safeDiagnostic,error:safeDiagnostic}};
}
