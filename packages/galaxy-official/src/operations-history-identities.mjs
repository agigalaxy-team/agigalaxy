// Resolve only already-authorized history actors, on the caller's connection.
// Names are current labels; immutable event IDs and actor references stay intact.
export async function operationsOperatorNamesWithin(db,{endpoint,operatorIds}){
 const ids=[...new Set((operatorIds??[]).filter(id=>typeof id==='string'&&id.length>0&&id.length<=256&&!id.startsWith('executor:')))];
 if(!ids.length||typeof endpoint!=='string'||!endpoint)return new Map();
 const rows=(await db.query('SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=ANY($2::text[])',[endpoint,ids])).rows;
 return new Map(rows.map(row=>[row.operator_id,typeof row.display_name==='string'?row.display_name.trim()||null:null]));
}
