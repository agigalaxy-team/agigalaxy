import {randomUUID} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsPolicySchemas,operationsPolicyKeySchema,operationsPageSchema,ruleSaveSchema,operationsProductParse as parse} from "../../shared/operations-product-schema.mjs";
import {operationsProductCommand,operationsStamp as stamp} from "./product-commands.mjs";

const view=row=>row?({key:row.policy_key,version:row.version,policy:row.policy,createdBy:row.created_by,source:row.source,createdAt:stamp(row.created_at)}):null;
export class OperationsProductRules{
  constructor({db,endpoint,businessAdmin,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,businessAdmin,now});}
  async bootstrap(policies){
    // Only actual, already-loaded configuration is an eligible baseline. A
    // restarted process never replaces a newer operator version with its file.
    return transaction(this.db,async db=>{
      for(const [key,policy]of Object.entries(policies)){
        parse(operationsPolicyKeySchema,key);const value=parse(operationsPolicySchemas[key],policy);
        await db.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at)
          VALUES($1,$2,1,$3,'configured-baseline',$4) ON CONFLICT DO NOTHING`,[this.endpoint,key,JSON.stringify(value),new Date(this.now()*1000).toISOString()]);
      }
    });
  }
  async currentWithin(db,key){
    return (await db.query('SELECT * FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key=$2 ORDER BY version DESC LIMIT 1',[this.endpoint,key])).rows[0]??null;
  }
  async list(operator){
    await this.businessAdmin.authorizeAction(operator,'rules.read');
    const items=[];for(const key of Object.keys(operationsPolicySchemas))items.push((await this.get(operator,key)).rule);
    return {items,protectedSources:[{key:'signed-governance',editable:false,reason:'existing-independent-review-required'}],checkedAt:this.now()};
  }
  async get(operator,key){
    await this.businessAdmin.authorizeAction(operator,'rules.read');parse(operationsPolicyKeySchema,key);
    const row=await this.currentWithin(this.db,key);
    if(!row)throw new ServiceError('operations_policy_not_initialized',503);
    const records=(await this.db.query(`SELECT * FROM operations_policy_processes_v1 WHERE endpoint=$1 AND policy_key=$2
      ORDER BY component,checked_at DESC,instance_id LIMIT 100`,[this.endpoint,key])).rows;
    return {rule:view(row),processes:records.map(process=>({component:process.component,instanceId:process.instance_id,
      adoptedVersion:process.adopted_version,attemptedVersion:process.attempted_version,errorCode:process.error_code,
      checkedAt:stamp(process.checked_at),fresh:this.now()-Date.parse(process.checked_at)/1000<=120,
      current:process.adopted_version===row.version&&!process.error_code&&this.now()-Date.parse(process.checked_at)/1000<=120})),checkedAt:this.now()};
  }
  async history(operator,key,input={}){
    await this.businessAdmin.authorizeAction(operator,'rules.read');parse(operationsPolicyKeySchema,key);const page=parse(operationsPageSchema,input);
    if(page.after&&BigInt(page.after)>2147483647n)throw new ServiceError('invalid_operations_product_request');
    const rows=(await this.db.query(`SELECT * FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key=$2 AND ($3::integer IS NULL OR version<$3)
      ORDER BY version DESC LIMIT $4`,[this.endpoint,key,page.after??null,page.limit+1])).rows;
    return {items:rows.slice(0,page.limit).map(view),nextAfter:rows.length>page.limit?String(rows[page.limit-1].version):null};
  }
  async save(operator,key,input){
    parse(operationsPolicyKeySchema,key);const data=parse(ruleSaveSchema,input),policy=parse(operationsPolicySchemas[key],data.policy);
    return operationsProductCommand(this,operator,'rule-save',{...data,key,policy},async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.endpoint+':operations-rule:'+key]);
      const current=await this.currentWithin(db,key);
      if(!current)throw new ServiceError('operations_policy_not_initialized',503);
      if(current.version!==data.expectedVersion)throw new ServiceError('operations_policy_version_changed',409);
      const row=(await db.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,created_by,source,created_at)
        VALUES($1,$2,$3,$4,$5,'business-operator',$6) RETURNING *`,[this.endpoint,key,current.version+1,JSON.stringify(policy),operator.operatorId,new Date(this.now()*1000).toISOString()])).rows[0];
      return {result:{rule:view(row),applicationState:'awaiting-process-adoption'},selection:{key,expectedVersion:data.expectedVersion},auditResult:{version:row.version}};
    });
  }
}

// The composition root supplies setters for the REAL existing service policies
// (including their budget copies). A setter must atomically adopt its validated
// value before resolving. No refresh is described as adopted before that point.
export function createOperationsPolicyRuntime({rules,component,instanceId=randomUUID(),consumers}){
  if(!['api','worker','content-publisher'].includes(component)||!consumers||!Object.keys(consumers).length)throw Error('Explicit policy consumers required');
  for(const [key,apply]of Object.entries(consumers))if(!operationsPolicySchemas[key]||typeof apply!=='function')throw Error('Invalid policy consumer');
  parse(operationsPolicyKeySchema,Object.keys(consumers)[0]);
  const adopted=new Map();let active=null;
  async function refresh(){
    const items=[];
    for(const [key,apply]of Object.entries(consumers)){
      const row=await rules.currentWithin(rules.db,key);if(!row)throw new ServiceError('operations_policy_not_initialized',503);
      let errorCode=null;
      try{
        if(adopted.get(key)!==row.version){
          const policy=parse(operationsPolicySchemas[key],row.policy);
          await apply(policy,{version:row.version});adopted.set(key,row.version);
        }
      }catch{errorCode='operations_policy_apply_failed';}
      await rules.db.query(`INSERT INTO operations_policy_processes_v1(endpoint,component,instance_id,policy_key,adopted_version,attempted_version,error_code,checked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint,component,instance_id,policy_key) DO UPDATE
        SET adopted_version=EXCLUDED.adopted_version,attempted_version=EXCLUDED.attempted_version,error_code=EXCLUDED.error_code,checked_at=EXCLUDED.checked_at`,
      [rules.endpoint,component,instanceId,key,adopted.get(key)??null,row.version,errorCode,new Date(rules.now()*1000).toISOString()]);
      items.push({key,adoptedVersion:adopted.get(key)??null,attemptedVersion:row.version,errorCode});
    }
    return {component,instanceId,items};
  }
  return {instanceId,refresh(){if(!active)active=refresh().finally(()=>{active=null;});return active;}};
}
