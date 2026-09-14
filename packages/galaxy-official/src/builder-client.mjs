import * as z from 'zod/v4';
import { conformanceRequestSchema } from './shared/conformance-schema.mjs';
import { verifyConformance } from './verification/conformance.mjs';
export { verifyConformance } from './verification/conformance.mjs';
export { verifyNodeControlSnapshot,verifyNodeControlProof } from './verification/node-control.mjs';
export { verifyHubDirectoryManifest } from './verification/hub-directory.mjs';
import { verifyHubDirectoryManifest } from './verification/hub-directory.mjs';
import { HUB_MANIFEST_PROFILE } from './verification/manifest.mjs';
import { verifyNodeControlSnapshot } from './verification/node-control.mjs';
import { nodeControlRequestSchema } from './shared/node-control-proof-schema.mjs';
import { createHash } from 'node:crypto';
import { builderEventSchema, builderReadSchema, builderQuerySchema, builderDeclarationSchema } from './shared/builders-schema.mjs';
import { builderOwnedQuerySchema,builderReceiptSchema,builderNoticesSchema } from './shared/builders-schema.mjs';
import { postPublicJson, fetchPublicJson, validatePublicUrl } from './public-fetch.mjs';

// The host supplies an existing exact-payload Consent; this client never grants it.
export function createBuilderClient({ endpoint, sessions, send = postPublicJson, trustedKeys, hubTrustedKeys, readHubManifest = fetchPublicJson, now = () => Math.floor(Date.now()/1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Builder client configuration.');
  const pending = new WeakMap();
  async function authorize(signal) {
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization?.scopes.includes('builders')) throw new Error('Builder authorization required.');
    return authorization;
  }
  async function check(authorization, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
      throw new Error('Builder authorization changed.');
    signal?.throwIfAborted();
  }
  function reject(authorization, error) {
    if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(authorization, 'remote-rejected');
    throw error;
  }
  function prepare({ consentId, payloadJson }) {
    z.uuid().parse(consentId);
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 28000) throw new Error('Invalid Builder payload.');
    const payload = JSON.parse(payloadJson);
    const event = builderEventSchema.parse(payload);
    const builderId = event.builderId;
    const expectedVersion = event.expectedRevision + 1;
    const path = '/v1/builders/events';
    const bodyJson = JSON.stringify({ consentId, payloadJson });
    const hash = createHash('sha256').update(bodyJson).digest('hex');
    const preview = Object.freeze({ endpoint, path, consentId, payloadJson, builderId, eventId: event.id,
      confirmation: `CONFIRM BUILDER ${event.id} ${hash}` });
    pending.set(preview, { event, builderId, expectedVersion, bodyJson, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown Builder preview.');
    operation.state = 'canceled'; operation.controller.abort();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact Builder confirmation required.');
    operation.state = 'executing';
    const { event, builderId, expectedVersion, controller } = operation;
    let authorization;
    try {
      authorization = await authorize(controller.signal);
      await check(authorization, controller.signal);
      const result = await send(endpoint + preview.path, { bodyJson: operation.bodyJson,
        credential: authorization.credential, signal: controller.signal });
      await check(authorization, controller.signal);
      if (!result || result.builderId !== builderId || result.eventId !== event.id || result.revision !== expectedVersion)
        throw new Error('Builder acknowledgement mismatch; check remote outcome.');
      operation.state = 'completed';
      return { builderId, eventId: result.eventId, revision: result.revision };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      if (authorization) reject(authorization, error);
      throw error;
    }
  }
  async function request(path,input,{signal}={}) {const authorization=await authorize(signal);
    try{await check(authorization,signal);const result=await send(endpoint+path,{bodyJson:JSON.stringify(input),credential:authorization.credential,signal,maxBytes:1048576});await check(authorization,signal);return result;}
    catch(error){reject(authorization,error);}
  }
  async function get(input,options){const query=builderReadSchema.parse(input),result=await request('/v1/builders/read',query,options);
    if(result?.builderId!==query.builderId||result.capabilityVerified!==false||!Array.isArray(result.versions))throw new Error('Invalid Builder response.');return result;}
  async function query(input={},options){const data=builderQuerySchema.parse(input),result=await request('/v1/builders/query',data,options);
    if(!Array.isArray(result?.items)||result.items.length>data.limit||result.automaticEndpointProbes!==false)throw new Error('Invalid Builder query.');return result;}
  async function specification(options){return request('/v1/builders/specification',{},options);}
  async function verifyHub(input,{signal}={}) {
    const {builderId,declarationId,manifestSha256}=z.object({builderId:z.uuid(),declarationId:z.uuid(),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input);
    const authorization=await authorize(signal),current=await get({builderId},{signal});
    const declared=builderDeclarationSchema.parse(current.declaration);
    if(current.type!=='hub'||current.declarationId!==declarationId||declared.type!=='hub'||declared.manifest.sha256!==manifestSha256
      ||current.registration?.state!=='registered'||current.delisted||current.securityIssue)throw new Error('Hub directory entry changed or unavailable.');
    if(declared.manifest.specVersion!==HUB_MANIFEST_PROFILE||declared.manifest.url!==declared.endpoint+'/.well-known/galaxy-network.json')
      throw new Error('Unsupported Hub directory Manifest profile.');
    const pins=hubTrustedKeys?.get(declared.endpoint);
    if(!(pins instanceof Map)||pins.size===0)throw new Error('Independent host-provided Hub pins required.');
    const pinSnapshot=()=>JSON.stringify([...pins].map(([kid,pin])=>[kid,pin.publicKeyPem,pin.notBefore,pin.notAfter,pin.revoked,pin.trustedUntil]));
    const pinState=pinSnapshot(),entryState=value=>JSON.stringify([value.revision,value.declarationId,value.declarationHash,value.declaration,value.registration,value.delisted,value.securityIssue]);
    const before=entryState(current);
    await check(authorization,signal);
    // The Hub gets an anonymous, explicit Manifest read only; registry session
    // credentials and the user's local identity never enter this request.
    const document=await readHubManifest(declared.manifest.url,{signal});
    const latest=await get({builderId},{signal});
    await check(authorization,signal);
    if(before!==entryState(latest)||hubTrustedKeys.get(declared.endpoint)!==pins||pinSnapshot()!==pinState)
      throw new Error('Hub declaration or trust changed during read.');
    const checkedAt=now(),result=await verifyHubDirectoryManifest(document,{declaration:declared,trustedKeys:pins,now:checkedAt});
    await check(authorization,signal);
    if(hubTrustedKeys.get(declared.endpoint)!==pins||pinSnapshot()!==pinState)throw new Error('Hub trust changed during verification.');
    return {...result,builderId,declarationId,checkedAt};
  }
  async function manage(input,options){const query=builderReadSchema.parse(input),result=await request('/v1/builders/manage/read',query,options);
    if(result?.mode!=='owner-management'||result.builderId!==query.builderId||result.capabilityVerified!==false||!Number.isInteger(result.revision))throw new Error('Invalid Builder management response.');return result;}
  async function owned(input={},options){const query=builderOwnedQuerySchema.parse(input),result=await request('/v1/builders/owned/query',query,options);
    if(result?.scope!=='current-owner'||!Array.isArray(result.items)||result.items.length>query.limit)throw new Error('Invalid owned Builder response.');return result;}
  async function receipt(input,options){const query=builderReceiptSchema.parse(input),result=await request('/v1/builders/events/receipt',query,options);
    if(result?.builderId!==query.builderId||result.eventId!==query.eventId||result.payloadHash!==query.payloadHash||!['absent','conflict','acknowledged'].includes(result.state)
      ||result.state==='acknowledged'&&(!Number.isInteger(result.revision)||!z.uuid().safeParse(result.consentId).success))throw new Error('Invalid Builder receipt.');return result;}
  async function notices(input,options){const query=builderNoticesSchema.parse(input),result=await request('/v1/builders/notices/query',query,options);
    if(result?.builderId!==query.builderId||!Array.isArray(result.items)||result.items.length>query.limit||result.declarationIncluded!==false)throw new Error('Invalid Builder notices.');return result;}
  async function exportNodeControl(input,options){
    const data=nodeControlRequestSchema.parse(input);
    if(!(trustedKeys instanceof Map))throw new Error('Configured Official signing pins required.');
    const response=await request('/v1/builders/node-control/export',data,options);
    if(!response||Object.keys(response).join(',')!=='signed')throw new Error('Invalid Node authorization response.');
    const verified=await verifyNodeControlSnapshot(response.signed,{endpoint,trustedKeys,now:now(),...data});
    return {...verified,currentRevocationChecked:true,checkedAt:verified.data.checkedAt};
  }
  async function exportReport(input,options) {
    const data=conformanceRequestSchema.parse(input);
    if(!(trustedKeys instanceof Map))throw new Error('Configured Official signing pins required.');
    const response=await request('/v1/builders/reports/export',data,options);
    if(!response||Object.keys(response).join(',')!=='signed')throw new Error('Invalid Conformance response.');
    const verified=await verifyConformance(response.signed,{endpoint,trustedKeys,now:now(),...data});
    return {...verified,currentRevocationChecked:true,checkedAt:verified.data.checkedAt};
  }
  return Object.freeze({prepare,execute,cancel,get,query,specification,exportReport,manage,owned,receipt,notices,exportNodeControl,
    ...(hubTrustedKeys instanceof Map?{verifyHub}:{})});
}
