export async function* honorCandidates(db,{providers,capabilityId,members,viewer}){
  let after=null;
  for(;;){
    const rows=(await db.query(`SELECT a.id FROM assistance_requests a JOIN assistance_events root ON root.id=a.id JOIN consents c ON c.id=root.consent_id
      WHERE a.snapshot->'selected'->>'providerId'=ANY($1::text[]) AND a.snapshot->'request'->>'capabilityId'=$2
      AND a.requester_id=ANY($3::text[]) AND (a.requester_id=$4 OR c.intent->'viewers' ? COALESCE($4,'')
        OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile') AND ($5::uuid IS NULL OR a.id>$5)
      ORDER BY a.id LIMIT 100`,[providers,capabilityId,members,viewer,after])).rows;
    for(const row of rows)yield row;
    if(rows.length<100)return;after=rows.at(-1).id;
  }
}
export async function* honorProofRecords(db,evidenceIds){
  let after=null;
  for(;;){
    const rows=(await db.query('SELECT id,evidence_id,payload_text FROM proofs WHERE evidence_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 50',[evidenceIds,after])).rows;
    for(const row of rows)yield row;
    if(rows.length<50)return;after=rows.at(-1).id;
  }
}
