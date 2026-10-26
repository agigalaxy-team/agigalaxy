import { randomUUID } from 'node:crypto';
import { OAuthError,OAuthErrorCode } from '@modelcontextprotocol/server';
import { ServiceError } from "../../shared/service-error.mjs";
import { bindingControl,lockSubjectControl } from "../../infrastructure/identity-control-repository.mjs";

const invalid=()=>new OAuthError(OAuthErrorCode.InvalidToken,'A current Galaxy account association and binding are required.');
const iso=value=>new Date(value*1000).toISOString();
export const oauthScope=scope=>'galaxy:'+scope;

// Only actors minted by this authority can take the OAuth branch. Spreading or
// fabricating public fields cannot turn a legacy caller into an OAuth caller.
export function createOAuthResourceAccess(access,{verifier,provider,allowedScopes}) {
  const records=new WeakMap();
  const select=`SELECT l.id AS link_id,l.subject_id,l.binding_id,b.scopes,b.expires_at,b.audience,b.device_id,b.key_id,b.control_epoch,
    ch.payload->>'installationId' AS installation_id FROM external_identity_links l
    JOIN bindings b ON b.id=l.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
    WHERE l.endpoint=$1 AND l.provider_id=$2 AND l.issuer=$3 AND l.external_subject=$4 AND l.client_id=$5
    AND l.revoked_at IS NULL AND b.revoked_at IS NULL AND b.subject_id=l.subject_id AND b.audience=$1 AND b.expires_at>$6`;
  const parameters=claim=>[access.endpoint,provider.id,provider.issuer,claim.subject,provider.clientId,iso(access.now())];
  const effective=(row,claim)=>row.scopes.filter(scope=>allowedScopes.includes(scope)&&claim.scopes.includes(oauthScope(scope)));
  const authority={ owns:actor=>records.has(actor),
    async authenticate(token,{httpRequestId=null}={}) {
      const claim=await verifier.verify(token);
      if(claim.issuer!==provider.issuer||claim.resource!==verifier.resource)throw invalid();
      const row=await bindingControl(access.db,(await access.db.query(select,parameters(claim))).rows[0]);if(!row)throw invalid();
      const scopes=effective(row,claim);
      const actor=Object.freeze({subjectId:row.subject_id,bindingId:row.binding_id,scopes:Object.freeze(scopes),httpRequestId,
        authentication:Object.freeze({version:2,profile:'oauth-resource',endpoint:access.endpoint,clientId:claim.clientId,audience:claim.resource,
          scope:'binding',bindingScopes:Object.freeze([...row.scopes]),credentialScopes:Object.freeze(scopes)})});
      records.set(actor,{claim,linkId:row.link_id});
      return {actor,authInfo:{token,clientId:claim.clientId,scopes:scopes.map(oauthScope),expiresAt:Math.min(claim.expiresAt,Date.parse(row.expires_at)/1000),resource:new URL(claim.resource)}};
    },
    async lock(db,actor) {
      const record=records.get(actor);if(!record||record.claim.expiresAt<=access.now())throw new ServiceError('access_denied',401);
      await lockSubjectControl(db,actor.subjectId);
      const row=await bindingControl(db,(await db.query(select+' AND l.id=$7 AND b.id=$8 FOR SHARE OF b,l',[...parameters(record.claim),record.linkId,actor.bindingId])).rows[0]);
      if(!row||row.subject_id!==actor.subjectId)throw new ServiceError('access_denied',401);
      return {...row,id:row.binding_id,binding_scopes:row.scopes,scopes:effective(row,record.claim)};
    },
    async record(db,actor,row,scope) {
      const record=records.get(actor);if(!record)throw new Error('OAuth actor unavailable.');
      const id=randomUUID(),claim=record.claim;
      await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,
        binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
        VALUES($1,'oauth.access',$2,$3,'accepted',1,$4,$5,$6,$7,$8,$3,$9::jsonb,$10::jsonb,$7,$4,$5,$9::jsonb)`,
      [actor.subjectId,record.linkId,id,claim.clientId,claim.resource,scope,actor.bindingId,actor.httpRequestId,
        JSON.stringify(row.binding_scopes),JSON.stringify(row.scopes)]);
    },
  };
  if(access.externalAuthorization)throw new Error('OAuth authority already configured.');
  access.externalAuthorization=Object.freeze(authority);
  return Object.freeze(authority);
}
