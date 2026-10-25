import {deserialize,serialize} from 'node:v8';
import {typedPublicReadKey,typedPublicReadStatement} from './public-read-templates.mjs';

// Only the original public forum reader calls this adapter. It batches bound
// instances of identical SELECT text within one DB transaction. It defines no
// qualification rules, stores no cross-request results and accepts no HTTP SQL.
const indexColumn='__galaxy_public_read_request__',orderColumn='__galaxy_public_read_row__';
const directOnly=sql=>!/^\s*SELECT\b/i.test(sql)||sql.includes(';')||(/\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/).test(sql)||(sql.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g)??[]).some(part=>/\$\d+/.test(part))||sql.includes('--')||sql.includes('/*');

export function publicReadBatch(db,{batchSize=32,reuseKnownBindings=false}={}){
 if(!db||typeof db.query!=='function'||!Number.isInteger(batchSize)||batchSize<1||batchSize>64)throw new Error('Bounded public reader DB required');
 const queue=new Map(),known=new Map();let running=false,failure=null;
 // A source wave owns this map; it is discarded before the next 100 candidates.
 // Replay independent native rows (Date/Buffer/JSON/BigInt included), preserving
 // driver fields and row order rather than letting one reader mutate another.
 const replay=result=>({...result,rows:deserialize(serialize(result.rows)),...(Array.isArray(result.fields)?{fields:result.fields.slice()}:{})});
 const schedule=()=>{if(!running){running=true;queueMicrotask(()=>{void flush();});}};
 const rejectPending=error=>{failure=error;for(const calls of queue.values())for(const call of calls)call.reject(error);queue.clear();};
 async function flush(){
  try{
   while(queue.size){
    const groups=[...queue.entries()];queue.clear();
    for(const[sql,calls]of groups)for(let offset=0;offset<calls.length;offset+=batchSize){
     const selected=calls.slice(offset,offset+batchSize);
     try{
      let statement=typedPublicReadStatement(sql,selected);
      if(!statement){
       const values=[];
       const branches=selected.map((call,index)=>{
        const shift=values.length;values.push(...call.values);
        const original=sql.replace(/\$(\d+)/g,(_,n)=>'$'+(Number(n)+shift));
        return `SELECT ${index}::integer AS "${indexColumn}", row_number() OVER () AS "${orderColumn}", original.* FROM (${original}) original`;
       });
       statement={text:branches.join(' UNION ALL ')+` ORDER BY "${indexColumn}","${orderColumn}"`,values};
      }
      const result=await db.query(statement.text,statement.values),rows=selected.map(()=>[]);
      for(const row of result.rows){const index=row[indexColumn];if(!Number.isInteger(index)||index<0||index>=rows.length)throw new Error('Public reader batch response invalid');const value={...row};delete value[indexColumn];delete value[orderColumn];rows[index].push(value);}
      for(let i=0;i<selected.length;i++)selected[i].resolve({...result,rows:rows[i],rowCount:rows[i].length,...(Array.isArray(result.fields)?{fields:result.fields.filter(field=>![indexColumn,orderColumn].includes(field.name))}:{})});
     }catch(error){for(const call of selected)call.reject(error);for(const call of calls.slice(offset+batchSize))call.reject(error);for(const[_other,remaining]of groups.slice(groups.findIndex(group=>group[0]===sql)+1))for(const call of remaining)call.reject(error);throw error;}
    }
   }
  }catch(error){rejectPending(error);}
  finally{running=false;if(queue.size&&!failure)schedule();}
 }
 return Object.freeze({query(sql,values=[]){
  if(failure)return Promise.reject(failure);
  if(typeof sql!=='string'||!Array.isArray(values))return Promise.reject(new Error('Fixed public SELECT required'));
  if(!/^\s*SELECT\b/i.test(sql))return Promise.reject(new Error('Public batch reader only accepts SELECT'));
  // Query literals/comments must never be parameter-rewritten. Unusual fixed
  // reader SELECTs retain the original driver path instead of being guessed.
  if(directOnly(sql))return db.query(sql,values);
  let key=null;
  try{if(reuseKnownBindings)key=typedPublicReadKey(sql,values);}catch(error){return Promise.reject(error);}
  if(key!==null&&known.has(key))return known.get(key).then(replay);
  const bound=key===null?values:values.map(value=>value instanceof Date?new Date(value.getTime()):value);
  const result=new Promise((resolve,reject)=>{const calls=queue.get(sql)??[];calls.push({values:bound,resolve,reject});queue.set(sql,calls);schedule();});
  if(key===null)return result;
  known.set(key,result);return result.then(replay);
 }});
}
