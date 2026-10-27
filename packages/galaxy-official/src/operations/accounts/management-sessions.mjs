import {createHash} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";

const denied=()=>new ServiceError('operations_access_denied',403);
const hash=value=>createHash('sha256').update(value).digest('hex');
const subject=value=>typeof value==='string'&&value!=='.'&&value!=='..'&&/^[A-Za-z0-9._:@-]{1,255}$/.test(value);

// Native SSO and this portal have separate sessions. This adapter owns only
// the portal effect and its late-login fence; it never edits native users.
export function createOperationsManagementSessions({db,endpoint,issuer,roleDirectory,now=()=>Math.floor(Date.now()/1000)}){
  if(!db||typeof endpoint!=='string'||typeof issuer!=='string'||typeof roleDirectory?.invalidateOperatorRoles!=='function')
    throw Error('Explicit management session configuration required.');
  function identity(value){
    if(!value||value.issuer!==issuer||!subject(value.externalSubject)||
      value.operatorId!==hash(issuer+'\0'+value.externalSubject))throw denied();
    return {operatorId:value.operatorId,issuer,externalSubject:value.externalSubject};
  }
  async function lock(connection,principal){
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912461))',
      [JSON.stringify([endpoint,principal.issuer,principal.externalSubject])]);
  }
  async function active(connection,principal){
    const row=(await connection.query(`SELECT issuer,external_subject,login_blocked,deleted_at
      FROM operations_management_accounts_v1 WHERE endpoint=$1 AND operator_id=$2`,[endpoint,principal.operatorId])).rows[0];
    if(row&&(row.issuer!==principal.issuer||row.external_subject!==principal.externalSubject||row.login_blocked||row.deleted_at))throw denied();
  }
  const withConnection=(connection,operation)=>connection?operation(connection):transaction(db,operation);
  return Object.freeze({
    async assertActive(value,{db:connection}={}){
      const principal=identity(value);return withConnection(connection,connection=>active(connection,principal));
    },
    async assertCallback(value,{db:connection,configurationId,tokenHash}={}){
      const principal=identity(value);
      if(!connection||!/^[a-f0-9]{64}$/.test(configurationId??'')||!/^[a-f0-9]{64}$/.test(tokenHash??''))throw denied();
      await lock(connection,principal);await active(connection,principal);
      const row=(await connection.query(`SELECT l.status,coalesce(l.started_at>f.revoked_before,true) AS after_fence
        FROM operations_operator_logins_v1 l
        LEFT JOIN operations_management_login_fences_v1 f ON f.endpoint=l.endpoint AND f.issuer=$5 AND f.external_subject=$6
        WHERE l.endpoint=$1 AND l.configuration_id=$2 AND l.token_hash=$3 AND l.expires_at>$4 FOR UPDATE OF l`,
      [endpoint,configurationId,tokenHash,new Date(now()*1000).toISOString(),principal.issuer,principal.externalSubject])).rows[0];
      if(row?.status!=='exchanging'||row.after_fence!==true)throw denied();
    },
    async summary(value,{db:connection}={}){
      const principal=identity(value);
      return withConnection(connection,async connection=>{
        const row=(await connection.query(`SELECT count(*)::integer AS count FROM operations_operator_sessions_v1
          WHERE endpoint=$1 AND operator_id=$2 AND issuer=$3 AND external_subject=$4 AND expires_at>$5
          AND (idle_expires_at IS NULL OR idle_expires_at>$6) AND (max_expires_at IS NULL OR max_expires_at>$6) AND refresh_state<>'revoked'`,
        [endpoint,principal.operatorId,principal.issuer,principal.externalSubject,new Date(now()*1000).toISOString(),now()])).rows[0];
        if(!Number.isSafeInteger(row?.count)||row.count<0)throw new ServiceError('operations_unavailable',503);
        return {state:'available',activeCount:row.count,scope:'management-portal'};
      });
    },
    async revoke(value,{db:connection}={}){
      const principal=identity(value);
      return withConnection(connection,async connection=>{
        await lock(connection,principal);
        await connection.query(`INSERT INTO operations_management_login_fences_v1(endpoint,issuer,external_subject,revoked_before)
          VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(endpoint,issuer,external_subject)
          DO UPDATE SET revoked_before=greatest(operations_management_login_fences_v1.revoked_before,EXCLUDED.revoked_before)`,
        [endpoint,principal.issuer,principal.externalSubject]);
        const result=await connection.query(`DELETE FROM operations_operator_sessions_v1
          WHERE endpoint=$1 AND operator_id=$2 AND issuer=$3 AND external_subject=$4 RETURNING token_hash`,
        [endpoint,principal.operatorId,principal.issuer,principal.externalSubject]);
        return {revokedSessions:result.rowCount??result.rows.length,inflightBlocked:true};
      });
    },
    async invalidate(value){
      const principal=identity(value);
      if(!roleDirectory.invalidateOperatorRoles(principal))throw denied();
      return {invalidated:true};
    },
  });
}
