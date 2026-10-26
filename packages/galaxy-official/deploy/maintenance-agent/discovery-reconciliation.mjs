import {readFile,lstat} from 'node:fs/promises';
import pg from 'pg';
import {createDiscoveryReadOnlySource} from '../../src/discovery-runtime/public-content-source.mjs';
import {discoveryItemReference} from '../../src/discovery-runtime/purpose.mjs';
import {MeilisearchClient,GorseClient} from '../../src/discovery-runtime/native-clients.mjs';
import {loadDiscoveryConfiguration} from '../../src/infrastructure/discovery-configuration.mjs';
import {loadForumPolicy} from '../../src/community-forum-policy-v1.mjs';
import {workerReads} from '../../src/infrastructure/worker-reads.mjs';
import {noSymlinkPath} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const maximum=100000,pageSize=200;
async function inventory(meili,gorse){
 const keys=new Set();let offset=0,total=null,cursor='',seen=new Set();
 if(meili)for(;;){
  const page=await meili.call('/indexes/'+meili.index+'/documents?'+new URLSearchParams({fields:'id',offset:String(offset),limit:String(pageSize)}));
  if(!Array.isArray(page.results)||page.results.length>pageSize||!Number.isSafeInteger(page.total)||page.total<0||page.total>maximum||total!==null&&total!==page.total)throw fail('maintenance_discovery_inventory_unconfirmed');
  total=page.total;for(const row of page.results){if(!discoveryItemReference(row.id)||keys.has(row.id))throw fail('maintenance_discovery_inventory_unconfirmed');keys.add(row.id);}
  offset+=page.results.length;if(offset===total)break;if(!page.results.length||offset>total)throw fail('maintenance_discovery_inventory_unconfirmed');
 }
 if(gorse)for(;;){
  const page=await gorse.call('/api/items?'+new URLSearchParams({n:String(pageSize),...(cursor?{cursor}:{})}));
  if(!Array.isArray(page.Items)||page.Items.length>pageSize||typeof page.Cursor!=='string')throw fail('maintenance_discovery_inventory_unconfirmed');
  for(const row of page.Items){if(!discoveryItemReference(row.ItemId)||seen.has(row.ItemId))throw fail('maintenance_discovery_inventory_unconfirmed');seen.add(row.ItemId);keys.add(row.ItemId);}
  if(keys.size>maximum)throw fail('maintenance_discovery_inventory_unconfirmed');if(!page.Cursor)break;
  if(cursor===page.Cursor||seen.has('cursor:'+page.Cursor))throw fail('maintenance_discovery_inventory_unconfirmed');seen.add('cursor:'+page.Cursor);cursor=page.Cursor;
 }
 return keys;
}

// Reconcile *all* item keys in the two configured dedicated native stores, not
// just current SQL rows/outbox. A stale restored key with no current DB object
// is removed too. Source qualification is the same original anonymous reader.
// This is neither a user-history purge nor a new interpretation of ID deletion:
// account/visitor analytics remain governed by their independent lifecycle.
export async function reconcileDiscoveryItems({source,meili=null,gorse=null}){
 // A restored native document task must not reinsert an obsolete body after
 // this reconciliation. Cancel only pending work for this configured index;
 // do not clear another index or treat ACK as completed cancellation.
 if(meili){await meili.task(await meili.call('/tasks/cancel?'+new URLSearchParams({indexUids:meili.index,statuses:'enqueued,processing'}),{method:'POST'}));
  const pending=await meili.call('/tasks?'+new URLSearchParams({indexUids:meili.index,statuses:'enqueued,processing',limit:'1'}));if(!Array.isArray(pending.results)||pending.results.length)throw fail('maintenance_discovery_pending_tasks_unconfirmed');}
 const keys=await inventory(meili,gorse);let removed=0,qualified=0;
 const remove=async key=>{if(meili)await meili.remove(key);if(gorse)await gorse.remove(key);};
 for(const key of keys){
  const reference=discoveryItemReference(key),document=await source.load(reference);
  if(!document){await remove(key);removed++;continue;}
  if(meili)await meili.upsert({id:document.id,kind:document.kind,sourceId:document.sourceId,version:document.indexVersion,title:document.title,body:document.body,topic:document.topic,tags:document.tags,publishedAt:document.publishedAt});
  const before=await source.load(reference);if(!before||before.indexVersion!==document.indexVersion){await remove(key);removed++;continue;}
  if(gorse)await gorse.upsert(before);
  const after=await source.load(reference);if(!after||after.indexVersion!==document.indexVersion){await remove(key);removed++;continue;}qualified++;
 }
 const final=await inventory(meili,gorse);
 for(const key of final)if(!keys.has(key)||!await source.load(discoveryItemReference(key)))throw fail('maintenance_discovery_reconciliation_unconfirmed');
 return{currentPublicSourcesReconciled:true,inspected:keys.size,removed,qualified,
  basis:'current-anonymous-public-reader-after-current-deletion-and-source-gates',
  nativeEffect:'configured-Meilisearch-documents-and-Gorse-item-delete-with-associated-feedback',
  independentAccountVisitorUsage:'preserved-at-point',physicalErasureProven:false};
}

export class MaintenanceDiscoveryReconciliation{
 constructor({config,run,fetchImpl=fetch,connect=options=>new pg.Pool({...options,max:1,connectionTimeoutMillis:5000,statement_timeout:30000})}){Object.assign(this,{config,run,fetchImpl,connect});}
 async withSource(context,operation){
  const search=context.intent.moduleIds.includes('search'),recommendation=context.intent.moduleIds.includes('recommendation');if(!search&&!recommendation)return{required:false};
  const config=await loadDiscoveryConfiguration('/var/lib/galaxy/config/pilot/discovery-api-20261023.json',{endpoint:context.authority.endpoint});
  if(!config?.sourceMetadata)throw fail('maintenance_current_discovery_source_metadata_required');
  const file='/etc/galaxy/pilot/worker.env';await noSymlinkPath(file);const info=await lstat(file);if(!info.isFile()||(info.mode&0o077)||info.size>262144)throw fail('maintenance_runtime_reference_invalid');
  const refs=(await readFile(file,'utf8')).split(/\r?\n/).filter(x=>x.startsWith('GALAXY_FORUM_POLICY_FILE='));if(refs.length>1)throw fail('maintenance_runtime_reference_invalid');
  const policy=refs[0]?.slice('GALAXY_FORUM_POLICY_FILE='.length),forumPolicy=await loadForumPolicy(policy);
  const cluster=this.config.postgres.find(x=>x.id==='business'),clone=context.artifacts.databases.find(x=>x.stanza==='business');
  if(!clone?.socketDirectory||clone.network!=='none'||clone.ports.length)throw fail('maintenance_private_recovery_socket_required');
  // Reuse the exact private candidate after current facts/deletion replay. Its
  // socket is explicitly host-bound by the isolated restore; no live cluster
  // password or new public/privileged HTTP reader is introduced here.
  const db=this.connect({host:clone.socketDirectory,user:cluster.administrator,database:cluster.database,port:5432});
  try{
   const source=createDiscoveryReadOnlySource({db,endpoint:context.authority.endpoint,now:()=>Math.floor(Date.now()/1000),readGrant:workerReads.readGrant,forumPolicy,...config.sourceMetadata});
   return{required:true,...await operation({source,meili:search?new MeilisearchClient({...config.meilisearch,fetch:this.fetchImpl}):null,gorse:recommendation?new GorseClient({...config.gorse,fetch:this.fetchImpl}):null})};
  }finally{await db.end();}
 }
 reconcile(context){return this.withSource(context,reconcileDiscoveryItems);}
 verify(context){return this.withSource(context,async({source,meili,gorse})=>{const keys=await inventory(meili,gorse);for(const key of keys)if(!await source.load(discoveryItemReference(key)))throw fail('maintenance_discovery_reconciliation_unconfirmed');return{currentPublicSourcesReconciled:true,checked:keys.size};});}
}
