import { failureRoute } from './adapters/http/failure-audit.mjs';
import { authenticatedRequestActor,bindRequestQuota,beginBodyMeasurement,consumedBodyBytes } from './adapters/http/request.mjs';
import { createRequestQuotas,defaultRequestQuotaPolicy,hasRequestCredential,websiteQuotaCredential } from './adapters/http/request-quotas.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ServiceError } from './shared/service-error.mjs';
import { createRoutes } from './adapters/http/routes.mjs';
import { clientAddressReader, fixedWindowLimiter, requestUrl } from './adapters/http/policy.mjs';
import { boundedReadiness } from './adapters/http/readiness.mjs';
import { validateBrowserOrigins, applyBrowserPolicy } from './adapters/http/browser-policy.mjs';
import {withRuntimeDiagnosticContext} from './shared/runtime-diagnostics.mjs';
import {runtimeLogEvent} from './operations/runtime-log.mjs';

const privateAgentOsPaths=new Set(['/v1/internal/agentos/authorize','/v1/internal/agentos/tools/execute',
  '/v1/internal/agentos/p13/context','/v1/internal/agentos/p13/step',
  '/v1/internal/agentos/autonomy/authorize','/v1/internal/agentos/autonomy/report','/v1/internal/agentos/autonomy/tools/execute','/v1/internal/agentos/autonomy/code']);
function verifiedAgentOsRequest(request,url,gateway){
  if(request.method!=='POST'||url.search||!privateAgentOsPaths.has(url.pathname)||typeof gateway?.verifyService!=='function')return false;
  // Service credentials select only a separate bounded transport counter.
  // Dispatch still authenticates again and resolves every current business permission.
  try{gateway.verifyService(request);return true;}catch{return false;}
}

export function createApi({ readiness = async () => true, failureAudit = null, logger = () => {}, rateLimit = 60,
  healthRateLimit = 120, searchPageLimit = 25, readinessTimeoutMs = 2000, trustedProxyAddresses = [], browserOrigins = [], releaseId, requestQuotaPolicy=null, quotaNow=Date.now, metrics=null, ...services }) {
  if (releaseId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(releaseId)) throw new Error('Invalid release ID');
  const checkReadiness = boundedReadiness(readiness, readinessTimeoutMs);
  const dispatch = createRoutes(services);
  const addressOf = clientAddressReader(trustedProxyAddresses);
  const allowedBrowserOrigins = validateBrowserOrigins(browserOrigins);
  const limit = fixedWindowLimiter({ limit: rateLimit });
  const healthLimit = fixedWindowLimiter({ limit: healthRateLimit });
  const searchPages=fixedWindowLimiter({limit:searchPageLimit,now:quotaNow});
  const quotas=requestQuotaPolicy?createRequestQuotas(requestQuotaPolicy,{now:quotaNow}):null;
  const agentOsQuotas=createRequestQuotas(requestQuotaPolicy??defaultRequestQuotaPolicy,{now:quotaNow});
  const log=input=>{try{logger(runtimeLogEvent(input));}catch{/* No raw request/error fallback. */}};
  const recordFailure = async (requestId, status, code, route, actor = null,diagnostic={}) => {
    let auditStatus;
    if (failureAudit) {
      try { auditStatus = await failureAudit({ requestId, status, route, actor }); }
      catch (error) { auditStatus = 'failed';log({event:'http_failure_audit_failed',requestId,route,stage:'audit-spool-record',error}); }
    }
    log({event:'http_rejected',requestId,status,code,route,...diagnostic,...(failureAudit?{auditStatus}:{})});
  };
  const server = createServer(async (request, response) => {
    let metricPath,bodyBytes=0;
    const finishMetric=metrics?.beginHttp();
    if(finishMetric){
      beginBodyMeasurement(request);
      const count=chunk=>typeof chunk==='string'?Buffer.byteLength(chunk):ArrayBuffer.isView(chunk)?chunk.byteLength:0;
      const write=response.write.bind(response),end=response.end.bind(response);
      response.write=function(chunk,encoding,...rest){
        bodyBytes+=typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:undefined):count(chunk);
        return write(chunk,encoding,...rest);
      };
      response.end=function(chunk,encoding,...rest){
        bodyBytes+=typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:undefined):count(chunk);
        return end(chunk,encoding,...rest);
      };
      response.once('finish',()=>finishMetric({method:request.method,path:metricPath,status:response.statusCode,bodyBytes,receivedBodyBytes:consumedBodyBytes(request)}));
      response.once('close',()=>finishMetric({method:request.method,path:metricPath,status:response.writableFinished?response.statusCode:499,bodyBytes,receivedBodyBytes:consumedBodyBytes(request)}));
    }
    const requestId = randomUUID();
    const startedAt=performance.now();
    let stage='http-request';
    response.setHeader('X-Request-Id', requestId);
    if (releaseId !== undefined) response.setHeader('X-Galaxy-Release', releaseId);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const send = (status, payload) => { response.statusCode = status; response.end(JSON.stringify(payload)); };
    let routeTag = 'http.request';
    let completed=false;
    const complete=()=>{if(completed)return;completed=true;log({event:'http_completed',requestId,route:routeTag,
      status:response.writableFinished?response.statusCode:499,stage,startedAt});};
    response.once('finish',complete);response.once('close',complete);
    let failureRecorded = false;
    const failed = (status, code,error) => {
      if (failureRecorded) return Promise.resolve();
      failureRecorded = true;
      return recordFailure(requestId,status,code,routeTag,authenticatedRequestActor(request),{stage,startedAt,...(error===undefined?{}:{error})});
    };
    request.once('aborted', () => { void failed(499, 'request_aborted'); });
    response.once('close', () => { if (!response.writableFinished) void failed(499, 'connection_closed'); });
    try {
      stage='http-address';
      const address = addressOf(request);
      let url;
      stage='http-url';
      try { url = requestUrl(request, services.bindings.endpoint, allowedBrowserOrigins); }
      catch (error) { limit(address, response); throw error; }
      routeTag = failureRoute(request.method, url.pathname);
      metricPath=url.pathname;
      const probe = request.method === 'GET' && ['/healthz', '/readyz'].includes(url.pathname);
      stage='http-quota';
      // Probe quota is independent from business traffic, but remains bounded.
      if(probe)healthLimit(address,response);
      else if(verifiedAgentOsRequest(request,url,services.agentOsGateway))agentOsQuotas.beginVerifiedService({address,response});
      else if(quotas){
        const websiteCredential=services.officialAccounts&&request.method!=='OPTIONS'?websiteQuotaCredential(request,url.pathname):null;
        if(websiteCredential)await quotas.beginWebsite({method:request.method,path:url.pathname,address,response,credential:websiteCredential,
          readCurrent:()=>services.officialAccounts.currentSession(request)});
        else bindRequestQuota(request,quotas.begin({method:request.method,path:url.pathname,hasCredential:hasRequestCredential(request,url.pathname),address,response}));
      }
      else limit(address,response);
      stage='http-browser-policy';
      if (applyBrowserPolicy(request, response, allowedBrowserOrigins)) return;
      if (probe) {
        stage='http-readiness';
        if (url.pathname === '/healthz') return send(200, { status: 'ok' });
        const ready = await withRuntimeDiagnosticContext({requestId,stage},()=>checkReadiness()) && (!services.incident || services.incident.canProcessEvidence());
        if (!ready) await failed(503, 'service_unavailable');
        return send(ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
      }
      services.incident?.assertRoute(request.method, url.pathname);
      services.retirement?.assertRoute(request.method, url.pathname);
      if ((services.retirement || services.incident) && request.method === 'GET' && url.pathname === '/v1/service-status') {
        const status=services.retirement?.snapshot()??{};
        if(services.incident){
          status.incident=services.incident.snapshot();
          status.businessWritesAccepted=(status.businessWritesAccepted??true)&&status.incident.businessWritesAccepted;
          status.downloadsAccepted=(status.downloadsAccepted??true)&&status.incident.sharingAccepted;
        }
        return send(200,status);
      }
      stage='http-dispatch';
      await withRuntimeDiagnosticContext({requestId,stage},()=>dispatch({ request, response, requestId, url, send,recordFailure:failed,consumeSearchPage:(actor,after)=>{
        if(after===undefined)return;
        const pageActor=actor?.kind==='official-account'&&/^[0-9a-f-]{36}$/.test(actor.accountId??'')?'account:'+actor.accountId:actor?'subject:'+actor.subjectId:'anonymous:'+address;
        try{searchPages(pageActor,response);}
        catch(error){response.setHeader('X-Galaxy-Quota-Category','search-pagination');throw error;}
      } }));
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 500;
      const code = error instanceof ServiceError ? error.code : 'internal_error';
      metrics?.quotaRejected(code);
      await failed(status, code,error);
      if (!response.headersSent) {
        const communityError = ['community_quota_exceeded','invitation_cooldown','community_restricted'].includes(code);
        if (communityError && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0)
          response.setHeader('Retry-After', String(error.retryAfterSeconds));
        send(status, { error: code, requestId,
          ...(communityError && error.quota ? { quota: error.quota } : {}),
          ...(code === 'community_restricted' ? { restrictionReason: error.restrictionReason } : {}) });
      }
      else response.destroy();
    }
  });
  const failedSockets = new WeakSet();
  server.on('clientError', (error, socket) => {
    if (failedSockets.has(socket)) { socket.destroy(); return; }
    failedSockets.add(socket);
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    metrics?.parserError(status);
    const requestId = randomUUID();
    void recordFailure(requestId,status,'http_parse_failed','http.parser',null,{stage:'http-parser',error});
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : status === 408 ? 'Request Timeout' : 'Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\nX-Request-Id: ${requestId}\r\n\r\n`);
    else socket.destroy();
  });
  // Raw uploads have their own 60s application deadline. JSON handlers keep
  // their size bound; a socket inactivity timer still caps stalled headers/body.
  server.requestTimeout = services.attachments?.specification().supported ? 70000 : 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  return server;
}
