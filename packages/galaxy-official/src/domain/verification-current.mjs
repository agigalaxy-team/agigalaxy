export async function currentVerificationJob(db,evidenceId,kind){
  return (await db.query(`SELECT * FROM jobs WHERE payload->>'evidenceId'=$1 AND kind=$2
    ORDER BY COALESCE((payload->'revalidation'->>'generation')::integer,0) DESC,id DESC LIMIT 1`,[evidenceId,kind])).rows[0]??null;
}
