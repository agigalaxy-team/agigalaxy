import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,createHash } from 'node:crypto';
import { lstat,readFile,writeFile,rename,rm } from 'node:fs/promises';
import { isAbsolute,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const execute=promisify(execFile);
const absolute=z.string().refine(isAbsolute,'Absolute path required');
const ocid=z.string().regex(/^ocid1\.[a-z0-9._-]+$/).max(512);
const configuration=z.object({version:z.literal(1),cli:absolute,region:z.string().regex(/^[a-z0-9-]+$/),
  auth:z.enum(['instance_principal','api_key']),configFile:absolute.optional(),profile:z.string().regex(/^[A-Za-z0-9_-]+$/).default('DEFAULT'),
  tenantId:ocid,scope:z.object({dimension:z.enum(['compartmentId','resourceId']),values:z.array(ocid).min(1).max(100)}).strict(),
  currency:z.string().regex(/^[A-Z]{3}$/),budget:z.number().nonnegative().nullable().default(null)}).strict()
  .refine(c=>c.auth!=='api_key'||c.configFile!==undefined,'API key authentication requires an explicit OCI configuration reference')
  .refine(c=>new Set(c.scope.values).size===c.scope.values.length,'Duplicate scope');

async function runCli(cli,args){
  try{
    const {stdout}=await execute(cli,args,{encoding:'utf8',windowsHide:true,shell:false,timeout:60000,maxBuffer:4*1024*1024});
    return JSON.parse(stdout);
  }catch{throw new Error('oci_cost_query_failed');} // Provider diagnostics may contain account/authentication details.
}

// Authentication, request signing, transport and provider retry behavior belong to Oracle's CLI.
// This adapter only selects a bounded cost query and converts complete results to the existing metric input.
export async function collectOciCost(input,{now=new Date(),run=runCli}={}){
  const config=configuration.parse(input),at=new Date(now);
  if(!Number.isFinite(at.valueOf()))throw new Error('Invalid collection time');
  const start=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),1));
  const end=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
  const periodEnd=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth()+1,1));
  if(end<=start)throw new Error('oci_cost_no_complete_day');
  const filter={operator:'OR',dimensions:config.scope.values.map(value=>({key:config.scope.dimension,value}))};
  const args=['usage-api','usage-summary','request-summarized-usages','--auth',config.auth,'--region',config.region,
    '--tenant-id',config.tenantId,'--query-type','COST','--granularity','DAILY','--is-aggregate-by-time','true',
    '--group-by',JSON.stringify(['service']),'--filter',JSON.stringify(filter),
    '--time-usage-started',start.toISOString(),'--time-usage-ended',end.toISOString(),
    '--output','json','--connection-timeout','10','--read-timeout','30','--max-retries','2'];
  if(config.configFile)args.push('--config-file',config.configFile);
  if(config.auth==='api_key')args.push('--profile',config.profile);
  let page=null,rows=0,amount=0,pages=0,rowsUsingQueryWindow=0;
  const seen=new Set();
  do{
    if(pages>=100)throw new Error('oci_cost_page_limit');
    const response=await run(config.cli,[...args,...(page?['--page',page]:[])]);pages++;
    if(!Array.isArray(response?.data?.items))throw new Error('oci_cost_invalid_response');
    for(const item of response.data.items){
      const value=item['computed-amount'],from=Date.parse(item['time-usage-started']),through=Date.parse(item['time-usage-ended']);
      // Aggregate-by-time responses may omit both per-row timestamps. In that
      // case the authenticated request's explicit UTC bounds define the range.
      const aggregateRange=item['time-usage-started']==null&&item['time-usage-ended']==null;
      if(!Number.isFinite(value)||value<0||item.currency!==config.currency||item['is-forecast']===true||
        !aggregateRange&&(!Number.isFinite(from)||!Number.isFinite(through)||from<start.valueOf()||through>end.valueOf()||from>=through))
        throw new Error('oci_cost_invalid_row');
      amount+=value;rows++;if(aggregateRange)rowsUsingQueryWindow++;
    }
    page=response['opc-next-page']??null;
    if(page!==null){
      if(typeof page!=='string'||!page.length||page.length>8192||seen.has(page))throw new Error('oci_cost_invalid_pagination');
      seen.add(page);
    }
  }while(page);
  if(!rows||!Number.isFinite(amount))throw new Error('oci_cost_unavailable');
  const scopeHash=createHash('sha256').update(JSON.stringify({tenantId:config.tenantId,region:config.region,filter})).digest('hex');
  return {cost:{version:2,currency:config.currency,kind:'billing-export',amount,budget:config.budget,
    periodStart:start.toISOString(),periodEnd:periodEnd.toISOString(),observedAt:at.toISOString(),
    scope:{dimension:config.scope.dimension,count:config.scope.values.length,sha256:scopeHash,attribution:'unallocated'}},
    receipt:{source:'oci-cost-analysis',pages,rows,rowsUsingQueryWindow,queriedThrough:end.toISOString(),observedAt:at.toISOString(),
      scopeHash,budgetConfigured:config.budget!==null}};
}

export async function refreshOciCost(input,output,options){
  if(!isAbsolute(output))throw new Error('Absolute cost output path required');
  // Preserve the last successful observation on any failed or incomplete collection.
  const result=await collectOciCost(input,options),temporary=output+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify(result.cost)+'\n',{flag:'wx',mode:0o600});
    await rename(temporary,output);
  }finally{await rm(temporary,{force:true});}
  return result.receipt;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [configPath,output,...extra]=process.argv.slice(2);
    if(!configPath||!output||extra.length||!isAbsolute(configPath))throw new Error('Arguments required');
    const info=await lstat(configPath);
    if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw new Error('Invalid collector configuration');
    const receipt=await refreshOciCost(JSON.parse(await readFile(configPath,'utf8')),output);
    console.log(JSON.stringify({event:'oci_cost_refreshed',...receipt}));
  }catch{
    console.error(JSON.stringify({event:'oci_cost_refresh_failed',usage:'node collect-oci-cost.mjs <absolute-config.json> <absolute-cost.json>'}));
    process.exitCode=1;
  }
}
