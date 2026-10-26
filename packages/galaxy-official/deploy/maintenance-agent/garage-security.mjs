import {timingSafeEqual} from 'node:crypto';

const fail=code=>Object.assign(Error(code),{code});
const bucketId=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const keyId=x=>typeof x==='string'&&/^[\x21-\x7e]{16,128}$/.test(x);
const text=x=>typeof x==='string'&&x.length<=1024&&!/[\p{Cc}]/u.test(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sorted=x=>x.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const perms=x=>x&&['read','write','owner'].every(k=>typeof x[k]==='boolean');
const none={read:false,write:false,owner:false},all={read:true,write:true,owner:true};
const secretEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

// Garage 2.4.1's native List* endpoints are capped at 10,000, without a
// continuation token. Equality with that cap cannot prove a complete list.
function inventory(rows,kind){
 if(!Array.isArray(rows)||rows.length>=10000||new Set(rows.map(x=>x.id)).size!==rows.length||rows.some(x=>kind==='bucket'?!bucketId(x.id):!keyId(x.id)))throw fail('maintenance_garage_inventory_incomplete');
 return rows;
}
function key(row,{secret=false}={}){
 if(!row||!keyId(row.accessKeyId)||!text(row.name)||typeof row.permissions?.createBucket!=='boolean'||(row.expiration!==null&&(!text(row.expiration)||!Number.isFinite(Date.parse(row.expiration))))||!Array.isArray(row.buckets))throw fail('maintenance_garage_facts_invalid');
 if(secret&&(typeof row.secretAccessKey!=='string'||!/^[\x21-\x7e]{16,512}$/.test(row.secretAccessKey)))throw fail('maintenance_garage_secret_unavailable');
 const buckets=row.buckets.map(x=>{if(!bucketId(x.id)||!perms(x.permissions)||!Array.isArray(x.localAliases)||x.localAliases.some(v=>!text(v)))throw fail('maintenance_garage_facts_invalid');return{id:x.id,permissions:{read:x.permissions.read,write:x.permissions.write,owner:x.permissions.owner},localAliases:sorted(x.localAliases)};});
 if(new Set(buckets.map(x=>x.id)).size!==buckets.length)throw fail('maintenance_garage_facts_invalid');
 return{accessKeyId:row.accessKeyId,name:row.name,expiration:row.expiration,permissions:{createBucket:row.permissions.createBucket},buckets:sorted(buckets),...(secret?{secretAccessKey:row.secretAccessKey}:{})};
}
function bucket(row){
 if(!row||!bucketId(row.id)||!Array.isArray(row.globalAliases)||row.globalAliases.some(x=>!text(x))||!Array.isArray(row.keys))throw fail('maintenance_garage_facts_invalid');
 const aliases=row.localAliases??row.keys.flatMap(x=>{if(!Array.isArray(x.bucketLocalAliases))throw fail('maintenance_garage_facts_invalid');return x.bucketLocalAliases.map(alias=>({accessKeyId:x.accessKeyId,alias}));});
 if(!Array.isArray(aliases))throw fail('maintenance_garage_facts_invalid');
 const localAliases=aliases.map(x=>{if(!keyId(x.accessKeyId)||!text(x.alias))throw fail('maintenance_garage_facts_invalid');return{accessKeyId:x.accessKeyId,alias:x.alias};});
 const keys=row.keys.map(x=>{if(!keyId(x.accessKeyId)||!perms(x.permissions))throw fail('maintenance_garage_facts_invalid');return{accessKeyId:x.accessKeyId,permissions:{read:x.permissions.read,write:x.permissions.write,owner:x.permissions.owner}};}).filter(x=>Object.values(x.permissions).some(Boolean));
 // Website access bypasses S3 key ACL and is therefore current authority too.
 if(typeof row.websiteAccess!=='boolean')throw fail('maintenance_garage_facts_invalid');
 const websiteConfig=row.websiteAccess?row.websiteConfig:null;
 if(row.websiteAccess&&(!websiteConfig||!text(websiteConfig.indexDocument)||(websiteConfig.errorDocument!==null&&websiteConfig.errorDocument!==undefined&&!text(websiteConfig.errorDocument))||(websiteConfig.routingRules?.length??0)!==0))throw fail('maintenance_garage_website_authority_unsupported');
 return{id:row.id,globalAliases:sorted(row.globalAliases),localAliases:sorted(localAliases),keys:sorted(keys),websiteAccess:row.websiteAccess,websiteConfig};
}
const project=({keys,buckets})=>({keys:sorted(keys.map(k=>({...k,buckets:sorted(k.buckets)}))),buckets:sorted(buckets)});

export class MaintenanceGarageSecurity{
 constructor({config,run}){Object.assign(this,{config,run});}
 binding(context){const row=context.footprint?.containers?.find(x=>x.id==='objects'&&x.state==='available');if(row?.name!=='galaxy-attachment-storage'||!/^sha256:[a-f0-9]{64}$/.test(row.image??''))throw fail('maintenance_garage_source_binding_required');return row;}
 async protocol(context){try{const row=this.binding(context),version=await this.run(this.config.tools.docker,['exec',row.name,'/garage','--version'],{timeout:15000,maxOutput:4096});if(!/^garage v2\.4\.1(?:\s|$)/.test(version.stdout.trim()))throw fail('maintenance_garage_version_not_supported');}catch(error){if(error.code?.startsWith('maintenance_'))throw error;throw fail('maintenance_garage_protocol_unavailable');}}
 async call(context,endpoint,payload=null){
  const allowed=['ListKeys','GetKeyInfo','ListBuckets','GetBucketInfo','ListAdminTokens','ImportKey','UpdateKey','DeleteKey','DenyBucketKey','AllowBucketKey','RemoveBucketAlias','AddBucketAlias','UpdateBucket','DeleteAdminToken'];
  if(!allowed.includes(endpoint))throw fail('maintenance_garage_operation_invalid');
  try{
   const row=this.binding(context),response=await this.run(this.config.tools.docker,['exec','-i',row.name,'/garage','json-api',endpoint,'-'],{input:JSON.stringify(payload),timeout:30000,maxOutput:20*1024*1024});
   return JSON.parse(response.stdout);
  }catch(error){if(error.code?.startsWith('maintenance_'))throw error;throw fail('maintenance_garage_native_operation_failed');}
 }
 async read(context,{secrets=false}={}){
  await this.protocol(context);
  const tokens=await this.call(context,'ListAdminTokens');
  if(!Array.isArray(tokens)||tokens.length>=10000)throw fail('maintenance_garage_inventory_incomplete');
  // Native 2.4.1 does not export/import the secret of persisted admin tokens.
  // Config-backed tokens have id:null and remain in current protected config.
  if(tokens.some(x=>x.id!==null))throw fail('maintenance_garage_current_admin_token_not_exportable');
  const keys=[];for(const row of inventory(await this.call(context,'ListKeys'),'key'))keys.push(key(await this.call(context,'GetKeyInfo',{id:row.id,showSecretKey:secrets}),{secret:secrets}));
  const buckets=[];for(const row of inventory(await this.call(context,'ListBuckets'),'bucket'))buckets.push(bucket(await this.call(context,'GetBucketInfo',{id:row.id})));
  const ids=new Set(keys.map(x=>x.accessKeyId));
  for(const row of buckets)if(row.keys.some(x=>!ids.has(x.accessKeyId))||row.localAliases.some(x=>!ids.has(x.accessKeyId)))throw fail('maintenance_garage_current_authority_inconsistent');
  for(const row of keys)for(const source of row.buckets){const target=buckets.find(x=>x.id===source.id),grant=target?.keys.find(x=>x.accessKeyId===row.accessKeyId)?.permissions??none;if(!target||!same(grant,source.permissions)||!same(sorted(target.localAliases.filter(x=>x.accessKeyId===row.accessKeyId).map(x=>x.alias)),source.localAliases))throw fail('maintenance_garage_current_authority_inconsistent');}
  return{version:1,image:this.binding(context).image,...project({keys,buckets}),adminTokens:'configuration-only'};
 }
 async capture(context){const first=await this.read(context,{secrets:true}),second=await this.read(context,{secrets:true});if(!same(first,second))throw fail('maintenance_garage_current_authority_changed');return first;}
 async restore(context,facts){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(context.intent?.operationId??'')||!context.intent.moduleIds?.includes('objects')||context.containment?.operationId!==context.intent.operationId||context.containment.publicActivation!==false)throw fail('maintenance_garage_contained_operation_required');
  await this.protocol(context);
  if(facts?.version!==1||facts.image!==this.binding(context).image||facts.adminTokens!=='configuration-only')throw fail('maintenance_garage_facts_invalid');
  const current=project({keys:facts.keys.map(x=>key(x,{secret:true})),buckets:facts.buckets.map(bucket)});
  const restoredBuckets=inventory(await this.call(context,'ListBuckets'),'bucket'),available=new Set(restoredBuckets.map(x=>x.id));
  // Do not invent missing current buckets or move a grant onto an alias/ID
  // from another point. This specific point needs the same current targets.
  if(current.buckets.some(x=>!available.has(x.id)))throw fail('maintenance_garage_current_bucket_missing_from_point');
  const oldKeys=inventory(await this.call(context,'ListKeys'),'key'),details=[];
  for(const row of oldKeys)details.push(key(await this.call(context,'GetKeyInfo',{id:row.id,showSecretKey:true}),{secret:true}));
  for(const row of current.keys){const old=details.find(x=>x.accessKeyId===row.accessKeyId);if(old&&!secretEqual(old.secretAccessKey,row.secretAccessKey))throw fail('maintenance_garage_existing_secret_conflict');}
  // Deny's true flags REMOVE permissions; Allow's false flags leave them
  // unchanged. Explicitly clear first, never use Allow(false) as revocation.
  const businessConfiguration=new Map();
  for(const row of restoredBuckets){const raw=await this.call(context,'GetBucketInfo',{id:row.id}),info=bucket(raw);businessConfiguration.set(row.id,{corsRules:raw.corsRules??null,lifecycleRules:raw.lifecycleRules??null});
   for(const grant of info.keys)await this.call(context,'DenyBucketKey',{bucketId:row.id,accessKeyId:grant.accessKeyId,permissions:all});
   for(const alias of info.localAliases)await this.call(context,'RemoveBucketAlias',{bucketId:row.id,accessKeyId:alias.accessKeyId,localAlias:alias.alias});
   for(const alias of info.globalAliases)await this.call(context,'RemoveBucketAlias',{bucketId:row.id,globalAlias:alias});
   await this.call(context,'UpdateBucket',{id:row.id,body:{websiteAccess:{enabled:false},...businessConfiguration.get(row.id)}});
  }
  for(const old of details)if(!current.keys.some(x=>x.accessKeyId===old.accessKeyId))await this.call(context,'DeleteKey',{id:old.accessKeyId});
  const tokens=await this.call(context,'ListAdminTokens');if(!Array.isArray(tokens)||tokens.length>=10000)throw fail('maintenance_garage_inventory_incomplete');
  for(const token of tokens)if(token.id!==null){if(!text(token.id))throw fail('maintenance_garage_facts_invalid');await this.call(context,'DeleteAdminToken',{id:token.id});}
  for(const row of current.keys){
   if(!details.some(x=>x.accessKeyId===row.accessKeyId))await this.call(context,'ImportKey',{accessKeyId:row.accessKeyId,secretAccessKey:row.secretAccessKey,name:row.name});
   // A deleted native tombstone cannot be imported by 2.4.1; native rejection
   // stays contained rather than forging/replacing that key's identity.
   await this.call(context,'UpdateKey',{id:row.accessKeyId,body:{name:row.name,expiration:row.expiration,neverExpires:row.expiration===null,deny:{createBucket:true}}});
   if(row.permissions.createBucket)await this.call(context,'UpdateKey',{id:row.accessKeyId,body:{allow:{createBucket:true}}});
  }
  for(const row of current.buckets){
   for(const grant of row.keys)if(Object.values(grant.permissions).some(Boolean))await this.call(context,'AllowBucketKey',{bucketId:row.id,accessKeyId:grant.accessKeyId,permissions:grant.permissions});
   for(const alias of row.globalAliases)await this.call(context,'AddBucketAlias',{bucketId:row.id,globalAlias:alias});
   for(const alias of row.localAliases)await this.call(context,'AddBucketAlias',{bucketId:row.id,accessKeyId:alias.accessKeyId,localAlias:alias.alias});
   if(row.websiteAccess)await this.call(context,'UpdateBucket',{id:row.id,body:{websiteAccess:{enabled:true,...row.websiteConfig},...businessConfiguration.get(row.id)}});
  }
  await this.verify(context,facts);return{required:true,currentKeysPreserved:true,currentBucketPermissionsPreserved:true,oldAuthorizationInvalidated:true,keyCount:current.keys.length,bucketCount:current.buckets.length};
 }
 async verify(context,facts){
  const observed=await this.read(context,{secrets:true}),available=new Set(facts.buckets.map(x=>x.id));
  const extra=observed.buckets.filter(x=>!available.has(x.id));
  if(extra.some(x=>x.keys.some(k=>Object.values(k.permissions).some(Boolean))||x.globalAliases.length||x.localAliases.length||x.websiteAccess))throw fail('maintenance_garage_old_authority_remains');
  if(!same(project({keys:observed.keys,buckets:observed.buckets.filter(x=>available.has(x.id))}),project(facts)))throw fail('maintenance_garage_current_authority_unconfirmed');
  return{currentKeysPreserved:true,currentBucketPermissionsPreserved:true};
 }
}
