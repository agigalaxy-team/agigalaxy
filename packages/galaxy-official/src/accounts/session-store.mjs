import {createHash} from 'node:crypto';
import {transaction} from "../infrastructure/database.mjs";

const hash = value => createHash('sha256').update(value).digest('hex');
const keyPattern = /^[a-f0-9]{64}$/;
const read = row => row ? {accountId:row.account_id,issuer:row.issuer,externalSubject:row.external_subject,
  account:{id:row.account_id,email:row.email,emailVerified:row.email_verified},
  tokenHash:row.token_hash,renewalRow:row,csrfToken:row.csrf_token,expiresAt:Number(row.expires_at)} : null;

export class OfficialAccountSessionStore {
  constructor({db,scope,now=()=>Math.floor(Date.now()/1000)}) {
    if (!keyPattern.test(scope ?? '')) throw Error('An exact account session scope is required.');
    Object.assign(this,{db,scope,now});
  }
  async createLogin({loginHash,preview,returnTo,previousLoginHash=null,observedSessionHash=null}) {
    const state=new URL(preview.authorizationUrl).searchParams.get('state'),at=this.now();
    if (!keyPattern.test(loginHash) || !state || !Number.isSafeInteger(preview.expiresAt) || preview.expiresAt<=at)
      throw Error('Invalid account login transaction.');
    return transaction(this.db,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(734912339,hashtext($1))',[this.scope]);
      await db.query('DELETE FROM official_account_logins_v1 WHERE scope_hash=$1 AND expires_at<=$2',[this.scope,at]);
      await db.query("DELETE FROM official_account_sessions_v1 WHERE scope_hash=$1 AND (expires_at<=$2 OR revoked_at IS NOT NULL OR idle_expires_at<=$2 OR refresh_state='revoked')",[this.scope,at]);
      const pending=(await db.query("SELECT count(*)::int AS n FROM official_account_logins_v1 WHERE scope_hash=$1 AND status IN ('pending','exchanging')",[this.scope])).rows[0].n;
      const active=(await db.query('SELECT count(*)::int AS n FROM official_account_sessions_v1 WHERE scope_hash=$1',[this.scope])).rows[0].n;
      if(pending>=2048||active>=10000)throw Error('Account login capacity reached.');
      let previous=null;
      if(previousLoginHash)previous=(await db.query(`UPDATE official_account_logins_v1 SET status='revoked'
        WHERE scope_hash=$1 AND login_hash=$2 AND status IN ('pending','exchanging') RETURNING preview`,[this.scope,previousLoginHash])).rows[0]?.preview??null;
      // An earlier callback may have committed while its cookie is still in
      // flight. Keep the session the browser actually presented; revoke only
      // unseen issuance tied to its superseded login.
      if(previousLoginHash)await db.query(`UPDATE official_account_sessions_v1 SET revoked_at=$4
        WHERE scope_hash=$1 AND login_hash=$2 AND token_hash IS DISTINCT FROM $3 AND revoked_at IS NULL`,
        [this.scope,previousLoginHash,observedSessionHash,at]);
      await db.query(`INSERT INTO official_account_logins_v1(scope_hash,login_hash,state_hash,preview,return_to,status,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,'pending',$6,$7)`,[this.scope,loginHash,hash(state),JSON.stringify(preview),returnTo,at,preview.expiresAt]);
      return previous;
    });
  }
  async claimLogin(loginHash,state) {
    if(!keyPattern.test(loginHash??'')||typeof state!=='string'||!state.length||state.length>512)return null;
    const row=(await this.db.query(`UPDATE official_account_logins_v1 SET status='exchanging'
      WHERE scope_hash=$1 AND login_hash=$2 AND state_hash=$3 AND expires_at>$4 AND status='pending'
      RETURNING preview,return_to,expires_at`,[this.scope,loginHash,hash(state),this.now()])).rows[0];
    return row?{preview:row.preview,returnTo:row.return_to,expiresAt:Number(row.expires_at)}:null;
  }
  async completeLogin(loginHash,{tokenHash,priorSessionHash=null},createSession) {
    return transaction(this.db,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(734912339,hashtext($1))',[this.scope]);
      // Logout/replacement can revoke an exchanging login. Hold this row through
      // issuance, so a delayed token response cannot undo that decision.
      const login=(await db.query('SELECT status,expires_at,started_at FROM official_account_logins_v1 WHERE scope_hash=$1 AND login_hash=$2 FOR UPDATE',
        [this.scope,loginHash])).rows[0];
      if(!login||login.status!=='exchanging'||Number(login.expires_at)<=this.now())throw Error('Account login is no longer current.');
      const count=(await db.query('SELECT count(*)::int AS n FROM official_account_sessions_v1 WHERE scope_hash=$1 AND revoked_at IS NULL AND expires_at>$2',[this.scope,this.now()])).rows[0].n;
      if(count>=10000)throw Error('Account session capacity reached.');
      const value=await createSession(db),at=this.now();
      // Identity is known only after OIDC verification. Compare inside the same
      // transaction and advisory lock as revocation, before issuing any session.
      // Database timestamps retain sub-millisecond precision; do not round this
      // fence through the JavaScript clock. A rejected issuance also rolls back
      // createSession's account/profile writes.
      const fenced=(await db.query(`SELECT 1 FROM operations_registered_login_fences_v1 f
        JOIN official_account_logins_v1 l ON l.scope_hash=f.scope_hash
        WHERE f.scope_hash=$1 AND f.issuer=$2 AND f.external_subject=$3
          AND l.login_hash=$4 AND l.started_at<=f.revoked_before LIMIT 1`,
        [this.scope,value.issuer,value.externalSubject,loginHash])).rows.length>0;
      if(fenced)throw Error('Account login was revoked before issuance.');
      if(priorSessionHash)await db.query('UPDATE official_account_sessions_v1 SET revoked_at=$3 WHERE scope_hash=$1 AND token_hash=$2 AND revoked_at IS NULL',
        [this.scope,priorSessionHash,at]);
      await db.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [this.scope,tokenHash,loginHash,value.accountId,value.issuer,value.externalSubject,value.account.email,value.account.emailVerified,value.csrfToken,at,value.expiresAt]);
      if(value.installRenewal)await value.installRenewal(db);
      await db.query("UPDATE official_account_logins_v1 SET status='completed' WHERE scope_hash=$1 AND login_hash=$2",[this.scope,loginHash]);
      return value;
    });
  }
  async failLogin(loginHash) {
    await this.db.query("UPDATE official_account_logins_v1 SET status='revoked' WHERE scope_hash=$1 AND login_hash=$2 AND status='exchanging'",[this.scope,loginHash]);
  }
  async session(tokenHash) {
    if(!keyPattern.test(tokenHash??''))return null;
    return read((await this.db.query(`SELECT * FROM official_account_sessions_v1
      WHERE scope_hash=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>$3`,[this.scope,tokenHash,this.now()])).rows[0]);
  }
  async logout(tokenHash,loginHash=null) {
    return transaction(this.db,async db=>{
      if(loginHash)await db.query("UPDATE official_account_logins_v1 SET status='revoked' WHERE scope_hash=$1 AND login_hash=$2 AND status IN ('pending','exchanging')",[this.scope,loginHash]);
      // This also revokes a login that committed immediately before logout,
      // while its response was still carrying the replacement cookie.
      await db.query(`UPDATE official_account_sessions_v1 SET revoked_at=$4
        WHERE scope_hash=$1 AND (token_hash=$2 OR login_hash=$3) AND revoked_at IS NULL`,[this.scope,tokenHash,loginHash,this.now()]);
    });
  }
  async sessionSummary({issuer,externalSubject}) {
    const row=(await this.db.query(`SELECT count(*)::int AS n FROM official_account_sessions_v1
      WHERE scope_hash=$1 AND issuer=$2 AND external_subject=$3
        AND revoked_at IS NULL AND expires_at>$4 AND (idle_expires_at IS NULL OR idle_expires_at>$4) AND refresh_state<>'revoked'`,[this.scope,issuer,externalSubject,this.now()])).rows[0];
    return {activeCount:row.n,scope:'website-portal'};
  }
  async revokePrincipal({issuer,externalSubject}) {
    return transaction(this.db,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(734912339,hashtext($1))',[this.scope]);
      await db.query(`INSERT INTO operations_registered_login_fences_v1(scope_hash,issuer,external_subject,revoked_before)
        VALUES($1,$2,$3,clock_timestamp())
        ON CONFLICT(scope_hash,issuer,external_subject) DO UPDATE
          SET revoked_before=GREATEST(operations_registered_login_fences_v1.revoked_before,clock_timestamp())`,
        [this.scope,issuer,externalSubject]);
      const result=await db.query(`UPDATE official_account_sessions_v1 SET revoked_at=$4
        WHERE scope_hash=$1 AND issuer=$2 AND external_subject=$3
          AND revoked_at IS NULL AND expires_at>$4 RETURNING token_hash`,
        [this.scope,issuer,externalSubject,this.now()]);
      return {revokedSessions:result.rows.length,inflightBlocked:true};
    });
  }
}
