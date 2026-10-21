import {transaction} from './database.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[a-f0-9]{64}$/;
function identity(input) {
  if (!keyPattern.test(input?.providerKey ?? '') || !uuid.test(input?.loginId ?? ''))
    throw Error('Invalid OIDC transaction reference.');
}

// Only server-side callers receive this interface. PKCE verifiers and nonces
// stay in the private database; previews, cookies and API responses omit them.
// DELETE RETURNING is the shared, once-only code-exchange authority.
export function createOidcTransactionStore({db, namespace, now = () => Math.floor(Date.now()/1000)}) {
  if (typeof namespace !== 'string' || !namespace.length || namespace.length > 256 || /\p{Cc}/u.test(namespace))
    throw Error('An exact OIDC transaction namespace is required.');
  return Object.freeze({
    async put(input) {
      identity(input);
      const at = now();
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at || input.expiresAt > at + 600
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier ?? '')
        || ![input.state,input.nonce].every(value => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/\p{Cc}/u.test(value)))
        throw Error('Invalid private OIDC transaction.');
      await transaction(db, async connection => {
        await connection.query('SELECT pg_advisory_xact_lock(734912338,hashtext($1))',[namespace]);
        await connection.query('DELETE FROM oidc_login_transactions_v1 WHERE namespace=$1 AND expires_at<=$2',[namespace,at]);
        const count = (await connection.query('SELECT count(*)::int AS n FROM oidc_login_transactions_v1 WHERE namespace=$1',[namespace])).rows[0].n;
        if (count >= 2048) throw Error('OIDC login capacity reached.');
        await connection.query(`INSERT INTO oidc_login_transactions_v1(namespace,provider_key,login_id,verifier,state,nonce,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[namespace,input.providerKey,input.loginId,input.verifier,input.state,input.nonce,at,input.expiresAt]);
      });
    },
    async take(input) {
      identity(input);
      if (typeof input.state !== 'string' || input.state.length > 512) return null;
      const row = (await db.query(`DELETE FROM oidc_login_transactions_v1
        WHERE namespace=$1 AND provider_key=$2 AND login_id=$3 AND state=$4 AND expires_at>$5
        RETURNING verifier,state,nonce`,[namespace,input.providerKey,input.loginId,input.state,now()])).rows[0];
      return row ?? null;
    },
    async cancel(input) {
      identity(input);
      return (await db.query('DELETE FROM oidc_login_transactions_v1 WHERE namespace=$1 AND provider_key=$2 AND login_id=$3 RETURNING login_id',
        [namespace,input.providerKey,input.loginId])).rows.length > 0;
    },
    async purge() {
      return (await db.query('DELETE FROM oidc_login_transactions_v1 WHERE namespace=$1 AND expires_at<=$2 RETURNING login_id',[namespace,now()])).rows.length;
    },
  });
}
