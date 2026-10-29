// A single pinned connection is required for the isolated recovery replay.
export async function transaction(pool,operation,{isolation='read committed'}={}){
 if(!['read committed','repeatable read'].includes(isolation))throw new Error('Unsupported transaction isolation');
 if(typeof pool.transaction==='function')return pool.transaction(async db=>{
  if(isolation==='repeatable read')await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  return operation(db);
 });
 const client=await pool.connect();let discard;
 try{
  await client.query(isolation==='repeatable read'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
  const result=await operation(client);await client.query('COMMIT');return result;
 }catch(error){
  try{await client.query('ROLLBACK');}catch(rollbackError){discard=rollbackError;}
  throw error;
 }finally{client.release(discard);}
}
