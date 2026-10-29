import {MeilisearchClient,GorseClient,OpenPanelClient} from '../support/native-clients.mjs';
import {OperationsAgentOsClient} from "../support/agentos-probe.mjs";
import {AttachmentClamAV} from '../support/attachment-clamav.mjs';
import {serviceConnectionSchema,serviceCredentialSchemas,serviceConnectionTestSchema} from '../../../galaxy-contracts/src/operations-service-connections-schema.mjs';

const result=(configuration,now)=>({id:configuration.id,kind:configuration.kind,state:'available',checkedAt:now(),checks:[],code:null});
export async function testServiceConnection(value,{credential=null,fetchImpl=fetch,scannerFactory=x=>new AttachmentClamAV(x),scannerPolicy=null,now=()=>Math.floor(Date.now()/1000)}={}){
 const configuration=serviceConnectionSchema.parse(value),answer=result(configuration,now),pass=kind=>answer.checks.push({kind,state:'passed'}),skip=kind=>answer.checks.push({kind,state:'not-tested'});
 try{
  if(configuration.kind==='file-scanning'){
   if(!scannerPolicy||!Number.isSafeInteger(scannerPolicy.maxSignatureAgeSeconds))throw Error('scanner_policy_unavailable');
   const scanner=scannerFactory({...configuration,...scannerPolicy,now}),ping=await scanner.command('PING');if(ping!=='PONG')throw Error();pass('transport');
   const version=/^ClamAV ([0-9.]+)\/([0-9]+)\/(.+)$/.exec(await scanner.command('VERSION'));if(!version)throw Error();
   const timestamp=Date.parse(version[3]+' UTC')/1000;
   if(!Number.isFinite(timestamp)||timestamp>now()+300||timestamp<now()-scannerPolicy.maxSignatureAgeSeconds){answer.code='service_connection_signatures_stale';throw Error();}
   pass('scanner-signatures');
  }else{
   const schema=serviceCredentialSchemas[configuration.kind],parsed=schema.safeParse(credential);
   if(!parsed.success){answer.code='service_connection_credentials_unavailable';throw Error();}
   if(configuration.kind==='search'){
    const client=new MeilisearchClient({...configuration,...parsed.data,fetch:fetchImpl,timeoutMs:10000}),health=await client.health();if(health?.status!=='available')throw Error();pass('transport');
    await client.settings();pass('authentication');pass('index');
   }else if(configuration.kind==='recommendation'){
    const value=await new GorseClient({...configuration,...parsed.data,fetch:fetchImpl,timeoutMs:10000}).health();if(value?.Ready!==true)throw Error();pass('transport');pass('authentication');
   }else if(configuration.kind==='analysis'){
    const client=new OpenPanelClient({...configuration,...parsed.data,fetch:fetchImpl,timeoutMs:10000});await client.health();pass('transport');
    // Read authentication is exercised without exposing aggregate data. The
    // writer is deliberately untested: a fake analytics event is not a probe.
    await client.tool('get_analytics_overview');pass('reader-authentication');skip('writer-authentication');
   }else{
    const client=new OperationsAgentOsClient({...configuration,...parsed.data,fetchImpl,now}),status=await client.status();
    if(status.state!=='connected'){answer.code='service_connection_runtime_not_ready';throw Error();}pass('transport');
    const metadata=await client.metadata('/galaxy/model-settings');if(typeof metadata?.version!=='string'||!Array.isArray(metadata.scenarios))throw Error();pass('authentication');pass('runtime');skip('execution-signature');
   }
  }
 }catch{answer.state='unavailable';answer.code??='service_connection_test_failed';}
 return serviceConnectionTestSchema.parse(answer);
}
