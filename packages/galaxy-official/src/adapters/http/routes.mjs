import {dispatchHubs} from './hub-http.mjs';
import {dispatchInformation} from './information-http.mjs';
import {dispatchTargetGovernance} from './target-governance-http.mjs';
import {dispatchIdentityGroups} from './identity-group-http.mjs';
import {dispatchWatchControls} from './watch-control-http.mjs';
import { ServiceError } from '../../shared/service-error.mjs';
import { body, authenticate } from './request.mjs';
import {dispatchAttachments} from './attachment-http.mjs';
import {dispatchOutcomeMaterials} from './outcome-material-http.mjs';
import {dispatchTrustPackages} from './trust-package-http.mjs';
import { searchQuerySchema,searchScope } from '../../shared/search-schema.mjs';
import { searchV2QuerySchema, searchV2ReferenceSchema, searchV2Scope } from '../../shared/search-v2-schema.mjs';

export function createRoutes({ watchControls,identityGroups,targetGovernance,information,informationWatches,packUses, hubs, peering, trustPackages, qualificationRequests, attachments, outcomeMaterials, configurations, choices, comments, commentGovernance, ciV2, contextV2, contributionSharing, requesterHistoryV2, recruitment, sharedSummaries, experienceReviews, qualificationCalculations, personalMcp, identity, identityControl, publicWrites, verificationRecords, chat, projects, contacts, inbox, summaries, bindings, access, consents, cases, evidence, proofs, history, search, profiles, discovery, assistance, context, notifications, qualification, moderation, honor, capsules, builders, audit, dataExport, deletion, manifest, keyring, docsMcp }) {
  return async function dispatch({ request, response, requestId, url, send,consumeSearchPage=()=>{},recordFailure=async()=>{} }) {
    const route = `${request.method} ${url.pathname}`;
    if(await dispatchWatchControls({watchControls,access,request,requestId,url,send,consumeSearchPage}))return;
    if(await dispatchIdentityGroups({identityGroups,access,request,requestId,url,send,consumeSearchPage}))return;
    if(await dispatchTargetGovernance({targetGovernance,access,request,requestId,url,send,consumeSearchPage}))return;
    if(await dispatchInformation({information,informationWatches,access,request,requestId,url,send,consumeSearchPage}))return;
    if(await dispatchHubs({hubs,peering,access,request,requestId,url,send,consumeSearchPage}))return;
    if(await dispatchTrustPackages({trustPackages,access,request,requestId,url,send,consumeSearchPage}))return;
    if(await dispatchAttachments({attachments,access,request,response,requestId,url,send}))return;
    if(await dispatchOutcomeMaterials({materials:outcomeMaterials,access,request,requestId,url,send}))return;
    const configurationPaths={'/v2/configurations/events':'submit','/v2/configurations/read':'get','/v2/configurations/query':'query','/v2/configurations/versions':'versions','/v2/configurations/receipt':'receipt'};
    if(configurations&&request.method==='POST'&&configurationPaths[url.pathname]){
      const method=configurationPaths[url.pathname],reading=!['submit','receipt'].includes(method);
      const authenticated=await authenticate(request,access,'history',reading),actor=authenticated?{...authenticated,httpRequestId:requestId}:null;
      const input=await body(request,method==='submit'?['consentId','payloadJson']:null);
      if(method==='query'||method==='versions')consumeSearchPage(actor,input.after??input.afterVersion);
      return send(200,await configurations[method](actor,input));
    }
    const choiceAction=/^\/v2\/choice-snapshots\/(preferences\/(?:read|save)|put|get|list|delete)$/.exec(url.pathname);
    if(choices&&request.method==='POST'&&choiceAction){
      const actor={...await authenticate(request,access,'binding'),httpRequestId:requestId};
      const method={'preferences/read':'preferences','preferences/save':'savePreference',put:'put',get:'get',list:'list',delete:'delete'}[choiceAction[1]];
      return send(200,await choices[method](actor,await body(request,choiceAction[1]==='preferences/read'?[]:null)));
    }
    const commentId=/^\/v2\/comments\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(comments&&(request.method==='GET'&&commentId||request.method==='POST'&&['/v2/comments','/v2/comments/query','/v2/comments/receipt'].includes(url.pathname))){
      const reading=request.method==='GET'||url.pathname.endsWith('/query');
      const authenticated=await authenticate(request,access,'assistance',reading),actor=authenticated?{...authenticated,httpRequestId:requestId}:null;
      if(commentId)return send(200,await comments.get(actor,commentId[1]));
      const input=await body(request,url.pathname==='/v2/comments'?['consentId','payloadJson']:null);
      if(url.pathname.endsWith('/query')){consumeSearchPage(actor,input.after);return send(200,await comments.query(actor,input));}
      return send(200,await comments[url.pathname.endsWith('/receipt')?'receipt':'submit'](actor,input));
    }
    const commentReport=/^\/v2\/comment-governance\/([0-9a-f-]{36})(?:\/(events))?$/.exec(url.pathname);
    if(commentGovernance&&(request.method==='GET'&&(commentReport&&!commentReport[2]||url.pathname==='/v2/comment-governance/config')||request.method==='POST'&&(commentReport?.[2]||['/v2/comment-governance/reports','/v2/comment-governance/query','/v2/comment-governance/receipt'].includes(url.pathname)))){
      const actor={...await authenticate(request,access,'moderation'),httpRequestId:requestId};
      if(request.method==='GET')return send(200,await(commentReport?commentGovernance.get(actor,commentReport[1]):commentGovernance.config(actor)));
      const writing=url.pathname.endsWith('/reports')||commentReport?.[2],input=await body(request,writing?['consentId','payloadJson']:null);
      if(commentReport)return send(200,await commentGovernance.event(actor,commentReport[1],input));
      if(url.pathname.endsWith('/query'))consumeSearchPage(actor,input.after);
      return send(200,await commentGovernance[url.pathname.endsWith('/reports')?'report':url.pathname.endsWith('/query')?'query':'receipt'](actor,input));
    }
    if (search?.v2 && request.method === 'POST' && ['/v2/search/query','/v2/search/reference'].includes(url.pathname)) {
      const reference = url.pathname.endsWith('/reference');
      const parsed = (reference ? searchV2ReferenceSchema : searchV2QuerySchema).safeParse(await body(request,null));
      if (!parsed.success) throw new ServiceError('invalid_search_v2_query');
      const query = reference ? parsed.data.search : parsed.data;
      const actor = await authenticate(request,access,searchV2Scope(query.type),true);
      consumeSearchPage(actor,query.query.after);
      return send(200,await search.v2[reference ? 'reference' : 'query'](actor,parsed.data));
    }
    if(ciV2&&request.method==='POST'&&url.pathname==='/v2/ci/receipts') {
      const input=await body(request,['id','type']);
      return send(200,await ciV2.receipt(await authenticate(request,access,input.type==='request'?'evidence':'proof'),input));
    }
    const ciAction = { '/v2/ci/requests': ['submit','evidence'], '/v2/ci/requests/read': ['get','evidence'], '/v2/ci/requests/revoke': ['revokeRequest','evidence'],
      '/v2/ci/proofs/preview': ['preview','proof'], '/v2/ci/proofs/publish': ['publish','proof'], '/v2/ci/proofs/read': ['getProof','proof'], '/v2/ci/proofs/revoke': ['revokeProof','proof'] }[url.pathname];
    const ciStatus=/^\/v2\/ci\/proofs\/([0-9a-f-]{36})\/status$/.exec(url.pathname);
    if(ciV2 && (request.method==='POST'&&ciAction || request.method==='GET'&&ciStatus)) {
      const [method,scope]=ciAction??['getProof','proof'];const authenticated=await authenticate(request,access,scope,method==='getProof');
      const actor=authenticated?{...authenticated,httpRequestId:requestId}:null;
      const input=ciStatus?{id:ciStatus[1]}:await body(request,['submit','publish'].includes(method)?['consentId','payloadJson']:null);
      return send(200,await ciV2[method](actor,input));
    }
    const contextV2Target = /^\/v2\/context\/([0-9a-f-]{36})(?:\/(metadata|events))?$/.exec(url.pathname);
    if (contextV2 && (request.method === 'POST' && ['/v2/context/grants','/v2/context/query','/v2/context/receipt'].includes(url.pathname)
      || contextV2Target && (request.method === 'GET' && contextV2Target[2] !== 'events' || request.method === 'POST' && contextV2Target[2] === 'events'))) {
      const actor = {...await authenticate(request,access,'context'),httpRequestId:requestId};
      if (request.method === 'GET') return send(200,await contextV2.get(actor,contextV2Target[1],{metadataOnly:contextV2Target[2] === 'metadata'}));
      const writing = url.pathname === '/v2/context/grants' || contextV2Target;
      const input = await body(request,writing ? ['consentId','payloadJson'] : null);
      if (contextV2Target) return send(200,await contextV2.submitEvent(actor,contextV2Target[1],input));
      if (url.pathname === '/v2/context/query') { consumeSearchPage(actor,input.after); return send(200,await contextV2.query(actor,input)); }
      return send(200,await contextV2[url.pathname.endsWith('/receipt') ? 'receipt' : 'create'](actor,input));
    }
    if (request.method === 'POST' && url.pathname === '/v2/consents/receipt') {
      const actor = await authenticate(request, access, 'consent'), input = await body(request, ['consentId']);
      return send(200, await consents.receipt(actor, input.consentId));
    }
    const contributionAction = { '/v2/contributions/status': 'status', '/v2/contributions/sources': 'ownedSources', '/v2/contributions/preview': 'preview', '/v2/contributions/publish': 'submit', '/v2/contributions/read': 'readProjection' }[url.pathname];
    if (contributionSharing && request.method === 'POST' && contributionAction) {
      const authenticated = await authenticate(request, access, 'history', contributionAction === 'readProjection');
      const actor = authenticated ? { ...authenticated, httpRequestId: requestId } : null;
      return send(200, await contributionSharing[contributionAction](actor, await body(request, contributionAction === 'submit' ? ['consentId', 'payloadJson'] : null)));
    }
    const honorStatus = /^\/v2\/honor\/(GUID[0-9A-Z]{28})\/([a-z0-9][a-z0-9._-]{0,79})\/([0-9]+(?:\.[0-9]+){0,2})$/.exec(url.pathname);
    if (honor?.v2 && (request.method === 'POST' && ['/v2/honor/query', '/v2/honor/ranking'].includes(url.pathname) || request.method === 'GET' && honorStatus)) {
      const actor = await authenticate(request, access, 'history', true);
      if (url.pathname.endsWith('/ranking')) return send(200, await honor.v2.ranking(await body(request, ['ruleId', 'ruleVersion'])));
      const input = honorStatus ? { subjectId: honorStatus[1], ruleId: honorStatus[2], ruleVersion: honorStatus[3] } : await body(request, null);
      if (!honorStatus) consumeSearchPage(actor, input.after);
      return send(200, await honor.v2.query(actor, input));
    }
    const requesterAction = { '/v2/requester-history/query': 'query', '/v2/requester-history/facts': 'facts' }[url.pathname];
    if (requesterHistoryV2 && request.method === 'POST' && requesterAction) {
      const actor = await authenticate(request, access, 'assistance', true), input = await body(request, null);
      consumeSearchPage(actor, input.after);
      return send(200, await requesterHistoryV2[requesterAction](actor, input));
    }
    const recruitmentRead = /^\/v2\/recruitment\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (recruitment && request.method === 'GET' && recruitmentRead)
      return send(200, await recruitment.get(await authenticate(request, access, 'history', true), recruitmentRead[1]));
    if (recruitment && request.method === 'POST' && ['/v2/recruitment','/v2/recruitment/query'].includes(url.pathname)) {
      const writing=url.pathname==='/v2/recruitment';
      const authenticated=await authenticate(request,access,'history',!writing),actor=authenticated?{...authenticated,httpRequestId:requestId}:null;
      return send(200,await recruitment[writing?'submit':'query'](actor,await body(request,writing?['consentId','payloadJson']:null)));
    }
    const experienceAction = { '/v2/experience/submit': [experienceReviews, 'submit', true], '/v2/experience/read': [experienceReviews, 'read', false],
      '/v2/qualification/evaluate': [qualification?.v2, 'evaluate', false], '/v2/qualification/candidates': [qualification?.v2, 'candidates', false], '/v2/qualification/calculation-permissions': [qualificationCalculations, 'submit', true], '/v2/qualification/calculation-receipt': [qualificationCalculations,'receipt',false], '/v2/qualification/calculation-owned': [qualificationCalculations,'owned',false], '/v2/qualification/permission-requests/plan':[qualificationRequests,'plan',false], '/v2/qualification/permission-requests/events':[qualificationRequests,'submit',true], '/v2/qualification/permission-requests/read':[qualificationRequests,'read',false], '/v2/qualification/permission-requests/query':[qualificationRequests,'query',false], '/v2/qualification/permission-requests/receipt':[qualificationRequests,'receipt',false] }[url.pathname];
    if (request.method === 'POST' && experienceAction?.[0]) {
      const actor = { ...await authenticate(request, access, 'assistance'), httpRequestId: requestId };
      return send(200, await experienceAction[0][experienceAction[1]](actor, await body(request, experienceAction[2] ? ['consentId', 'payloadJson'] : null)));
    }
    const summaryMethods = { 'preferences/read': 'preferences', 'preferences/save': 'savePreference', put: 'put', get: 'get', list: 'list', delete: 'delete', sources: 'sources' };
    const summaryAction = /^\/v2\/personal-summaries\/(preferences\/(?:read|save)|put|get|list|delete|sources)$/.exec(url.pathname);
    if (summaries && request.method === 'POST' && summaryAction) {
      const actor = { ...await authenticate(request, access, 'binding'), httpRequestId: requestId };
      return send(200, await summaries[summaryMethods[summaryAction[1]]](actor, await body(request, summaryAction[1] === 'preferences/read' ? [] : null)));
    }
    const inboxMethods = { query: 'query', 'options/read': 'options', 'options/save': 'saveOptions', 'presentation/claim': 'claim', 'presentation/ack': 'presented', read: 'markRead' };
    const inboxAction = /^\/v2\/notifications\/(query|options\/(?:read|save)|presentation\/(?:claim|ack)|read)$/.exec(url.pathname);
    if (inbox && request.method === 'POST' && inboxAction) {
      const actor = { ...await authenticate(request, access, 'notifications'), httpRequestId: requestId };
      return send(200, await inbox[inboxMethods[inboxAction[1]]](actor, await body(request, inboxAction[1] === 'options/read' ? [] : null)));
    }
    const contactRead = /^\/v2\/contacts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (contacts && (request.method === 'GET' && contactRead || request.method === 'POST' && ['/v2/contacts', '/v2/contacts/query'].includes(url.pathname))) {
      const actor = { ...await authenticate(request, access, 'history'), httpRequestId: requestId };
      if (contactRead) return send(200, await contacts.get(actor, contactRead[1]));
      const input = await body(request, url.pathname === '/v2/contacts' ? ['consentId', 'payloadJson'] : null);
      return send(200, await contacts[url.pathname === '/v2/contacts' ? 'submit' : 'query'](actor, input));
    }
    const projectRead = /^\/v2\/projects\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (projects && request.method === 'GET' && projectRead)
      return send(200, await projects.get(await authenticate(request, access, 'history', true), projectRead[1]));
    const projectPreference = /^\/v2\/projects\/([0-9a-f-]{36})\/preferences\/(read|save)$/.exec(url.pathname);
    if (projects && request.method === 'POST' && (url.pathname === '/v2/projects' || url.pathname === '/v2/projects/query' || projectPreference)) {
      const actor = { ...await authenticate(request, access, 'history'), httpRequestId: requestId };
      if (url.pathname === '/v2/projects') return send(200, await projects.submit(actor, await body(request, ['consentId', 'payloadJson'])));
      if (url.pathname === '/v2/projects/query') return send(200, await projects.list(actor, await body(request, null)));
      const input = await body(request, projectPreference[2] === 'read' ? [] : null);
      return send(200, await projects[projectPreference[2] === 'read' ? 'preferences' : 'savePreferences'](actor, projectPreference[1], input));
    }
    const sharedAction = /^\/v2\/chat\/shared-summaries\/(publish|get|list|retract)$/.exec(url.pathname);
    if (sharedSummaries && request.method === 'POST' && sharedAction) {
      const actor = { ...await authenticate(request, access, 'binding'), httpRequestId: requestId };
      return send(200, await sharedSummaries[sharedAction[1]](actor, await body(request, null)));
    }
    if (chat && request.method === 'POST' && url.pathname.startsWith('/v2/chat/')) {
      const actor = { ...await authenticate(request, access, 'binding'), httpRequestId: requestId };
      const input = await body(request, null);
      const globalMethod = { '/v2/chat/rooms/create': 'create', '/v2/chat/rooms/query': 'list',
        '/v2/chat/invitations/query': 'invitations', '/v2/chat/export/owned': 'exportOwned' }[url.pathname];
      if (globalMethod) return send(200, await chat[globalMethod](actor, input));
      const roomRoute = /^\/v2\/chat\/rooms\/([0-9a-f-]{36})\/(read|history|decisions|propose|vote|accept|leave|dismiss|send|receipt|cursor|agent-grants|agent-participants|agent-grant|agent-revoke)$/.exec(url.pathname);
      if (roomRoute) {
        const method = { read: 'get', history: 'history', decisions: 'decisions', propose: 'proposeDecision', vote: 'voteDecision', accept: 'acceptInvite',
          leave: 'leave', dismiss: 'dismissDecision', send: 'send', receipt: 'messageStatus', cursor: 'cursor', 'agent-grants': 'queryAgentGrants', 'agent-participants':'queryAgentParticipants', 'agent-grant': 'grantAgent', 'agent-revoke': 'revokeAgent' }[roomRoute[2]];
        return send(200, await chat[method](actor, roomRoute[1], input));
      }
      const messageRoute = /^\/v2\/chat\/rooms\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/(edit|retract|hide)$/.exec(url.pathname);
      if (messageRoute) return send(200, await chat[messageRoute[3]](actor, messageRoute[1], messageRoute[2], input));
      throw new ServiceError('not_found', 404);
    }
    const controlRoute = /^\/v2\/identity\/control\/(challenges|commit|status|cancel)$/.exec(url.pathname);
    if (identityControl && request.method === 'POST' && controlRoute)
      return send(200, await identityControl[controlRoute[1] === 'challenges' ? 'challenge' : controlRoute[1]](await body(request, null)));
    const controlState = /^\/v2\/identity\/(GUID[0-9A-Z]{28})\/control$/.exec(url.pathname);
    if (identityControl && request.method === 'GET' && controlState)
      return send(200, await identityControl.publicState(controlState[1]));
    if (route === 'POST /v2/binding-challenges')
      return send(200, await bindings.challengeV2(await body(request, null)));
    if (history && route === 'POST /v2/history/query')
      return send(200, await history.queryV2(await authenticate(request, access, 'history', true), await body(request, null)));
    if (discovery?.v2 && request.method === 'POST' && ['/v2/discovery/query', '/v2/discovery/detail'].includes(url.pathname)) {
      const actor = await authenticate(request, access, 'history', true);
      return send(200, await discovery.v2[url.pathname.endsWith('/detail') ? 'detail' : 'query'](actor, await body(request, null)));
    }
    const capsuleV2Methods = {
      '/v2/capsules/events': 'publishV2', '/v2/capsules/uses': 'recordUseV2',
      '/v2/capsules/read': 'getV2', '/v2/capsules/query': 'queryV2',
      '/v2/capsules/uses/query': 'usesV2', '/v2/capsules/preview': 'previewV2',
      '/v2/capsules/permissions': 'permissionV2', '/v2/capsules/permissions/read': 'permissionReadV2',
      '/v2/capsules/receipt': 'receiptV2', '/v2/capsules/versions': 'versionsV2', '/v2/capsules/permissions/query': 'permissionsQueryV2',
    };
    if (capsules?.v2 && request.method === 'POST' && capsuleV2Methods[url.pathname]) {
      const writing = ['/v2/capsules/events', '/v2/capsules/uses', '/v2/capsules/permissions'].includes(url.pathname);
      const privateRead = ['/v2/capsules/preview', '/v2/capsules/permissions/read', '/v2/capsules/receipt', '/v2/capsules/permissions/query'].includes(url.pathname);
      const authenticated = await authenticate(request, access, 'capsules', !writing && !privateRead);
      const actor = authenticated ? { ...authenticated, httpRequestId: requestId } : null;
      const input = await body(request, writing ? ['consentId', 'payloadJson'] : null);
      if (url.pathname.endsWith('/query')) consumeSearchPage(actor, input.after);
      return send(200, await capsules[capsuleV2Methods[url.pathname]](actor, input));
    }
    const verificationRoute = /^\/v2\/verification-records\/(submit|read|status)$/.exec(url.pathname);
    if (verificationRecords && request.method === 'POST' && verificationRoute) {
      const actor = { ...await authenticate(request, access, 'evidence'), httpRequestId: requestId };
      const method = verificationRoute[1] === 'read' ? 'get' : verificationRoute[1];
      return send(200, await verificationRecords[method](actor, await body(request, null)));
    }
    if (cases && route === 'POST /v2/cases/events') {
      const actor = { ...await authenticate(request, access, 'case-teaser'), httpRequestId: requestId };
      return send(200, await cases.submitV2(actor, await body(request, ['consentId','payloadJson'])));
    }
    if (cases && route === 'POST /v2/cases/intervention-responses') {
      const actor = { ...await authenticate(request, access, 'case-teaser'), httpRequestId: requestId };
      const input = await body(request, ['requests']); return send(200, await cases.respondBatch(actor, input.requests));
    }
    const caseReadV2 = /^\/v2\/cases\/([0-9a-f-]{36})\/read$/.exec(url.pathname);
    if (cases && request.method === 'POST' && caseReadV2)
      return send(200, await cases.getV2(await authenticate(request, access, 'case-teaser'), caseReadV2[1], await body(request,null)));
    if (assistance && request.method === 'GET' && url.pathname === '/v2/tasks')
      return send(200, await assistance.queryPublicTasks());
    const taskRead = /^\/v2\/tasks\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (assistance && request.method === 'GET' && taskRead) {
      const actor = await authenticate(request, access, 'assistance', true);
      return send(200, await (actor ? assistance.getTask(actor, taskRead[1]) : assistance.getPublicTask(taskRead[1])));
    }
    if (assistance && route === 'POST /v2/tasks/query') {
      const actor = await authenticate(request, access, 'assistance', true), input = await body(request, null);
      return send(200, await (actor ? assistance.queryTasks(actor, input) : assistance.queryPublicTasks(input)));
    }
    if (assistance && route === 'POST /v2/tasks/receipt')
      return send(200, await assistance.taskReceipt(await authenticate(request, access, 'assistance'), await body(request,null)));
    if (assistance && route === 'POST /v2/tasks') {
      const actor = { ...await authenticate(request, access, 'assistance'), httpRequestId: requestId };
      return send(200, await assistance.createTask(actor, await body(request,['consentId','payloadJson'])));
    }
    const taskAction = /^\/v2\/tasks\/([0-9a-f-]{36})\/(events|participations|case)$/.exec(url.pathname);
    if (assistance && request.method === 'POST' && taskAction) {
      const actor = { ...await authenticate(request, access, taskAction[2] === 'case' ? 'case-teaser' : 'assistance'), httpRequestId: requestId };
      const input = await body(request, null);
      if (taskAction[2] === 'case') return send(200, await cases.createAndLinkTask(actor,{...input,taskId:taskAction[1]}));
      return send(200, await (taskAction[2] === 'events' ? assistance.submitTaskEvent(actor,taskAction[1],input)
        : assistance.proposeParticipation(actor,taskAction[1],input)));
    }
    const participationAction = /^\/v2\/participations\/([0-9a-f-]{36})\/events$/.exec(url.pathname);
    if (assistance && request.method === 'POST' && participationAction) {
      const actor = { ...await authenticate(request, access, 'assistance'), httpRequestId: requestId };
      return send(200, await assistance.submitParticipationEvent(actor,participationAction[1],await body(request,['consentId','payloadJson'])));
    }
    if (publicWrites && route === 'POST /v2/account/quotas') {
      const actor = await authenticate(request, access, 'binding'); await body(request, []);
      return send(200, await publicWrites.status(actor));
    }
    if(personalMcp&&request.method==='GET'&&url.pathname===personalMcp.metadataPath)return send(200,personalMcp.metadata());
    if(personalMcp&&url.pathname==='/mcp/personal')return personalMcp.handle(request,response,{requestId,recordFailure});
    const callback = /^\/v1\/identity\/callback\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(url.pathname);
    if (identity && request.method === 'GET' && callback) {
      response.setHeader('Referrer-Policy', 'no-referrer');
      return send(200, await identity.callback(callback[1], url.href));
    }
    const identityRoute = /^\/v1\/identity\/(providers|begin|status|cancel|confirm|query|revoke)$/.exec(url.pathname);
    if (identity && request.method === 'POST' && identityRoute) {
      const actor = { ...await authenticate(request, access, 'binding'), httpRequestId: requestId };
      const input = await body(request, identityRoute[1] === 'providers' ? [] : null);
      return send(200, await identity[identityRoute[1]](actor, input));
    }
    if(route==='POST /v1/bindings/query')return send(200,await bindings.query(await authenticate(request,access,'binding'),await body(request,null)));
    if(search&&route==='POST /v1/search/query'){
      const parsed=searchQuerySchema.safeParse(await body(request,null));if(!parsed.success)throw new ServiceError('invalid_search_query');
      const actor=await authenticate(request,access,searchScope(parsed.data.type),true);
      consumeSearchPage(actor,parsed.data.query.after);
      return send(200,await search.query(actor,parsed.data));
    }
    if(profiles&&route==='POST /v1/profiles/statements'){
      const actor={...await authenticate(request,access,'history'),httpRequestId:requestId};
      return send(200,await profiles.publish(actor,await body(request,['consentId','payloadJson'])));
    }
    if (discovery && request.method === 'POST' && ['/v1/discovery/query', '/v1/discovery/preferences/read', '/v1/discovery/preferences/save'].includes(url.pathname)) {
      const query = url.pathname.endsWith('/query');
      const actor = { ...await authenticate(request, access, query ? 'history' : 'notifications'), httpRequestId: requestId };
      if (url.pathname.endsWith('/read')) { await body(request, []); return send(200, await discovery.preferences(actor)); }
      return send(200, await discovery[query ? 'query' : 'save'](actor, await body(request, null)));
    }
    if (deletion && request.method === 'POST' && url.pathname === '/v1/deletion-requests/status') {
      const { signed } = await body(request, ['signed']); return send(200, await deletion.statusWithProof(signed));
    }
    if (deletion && request.method === 'POST' && ['/v1/deletion-requests/config','/v1/deletion-requests/submit','/v1/deletion-requests/read','/v1/deletion-requests/query'].includes(url.pathname)) {
      const actor = { ...await authenticate(request, access, 'data-delete'), httpRequestId: requestId }, method = url.pathname.split('/').at(-1);
      if (method === 'config') { await body(request, []); return send(200, await deletion.config(actor)); }
      if (method === 'submit') { const { signed } = await body(request, ['signed']); return send(200, await deletion.submit(actor, signed)); }
      return send(200, await deletion[method](actor, await body(request, null)));
    }
    if (dataExport && request.method === 'POST' && ['/v1/data-exports/specification', '/v1/data-exports/create', '/v1/data-exports/page', '/v1/data-exports/binary', '/v1/data-exports/revoke'].includes(url.pathname)) {
      const actor = { ...await authenticate(request, access, 'data-export'), httpRequestId: requestId };
      if (url.pathname.endsWith('/specification')) { await body(request, []); return send(200, await dataExport.specification(actor)); }
      const method = url.pathname.split('/').at(-1);
      return send(200, await dataExport[method](actor, await body(request, null)));
    }
    if (audit && request.method === 'POST' && ['/v1/audit/config', '/v1/audit/query', '/v1/audit/export',
      '/v1/audit/grants', '/v1/audit/grants/approve', '/v1/audit/grants/revoke'].includes(url.pathname)) {
      const review = url.pathname.endsWith('/approve') || url.pathname.endsWith('/revoke');
      const actor = { ...await authenticate(request, access, review ? 'audit-review' : 'audit'), httpRequestId: requestId };
      if (url.pathname.endsWith('/config')) { await body(request, []); return send(200, await audit.config(actor)); }
      if (url.pathname === '/v1/audit/grants') { await body(request, []); return send(200, await audit.listGrants(actor)); }
      if (url.pathname.endsWith('/approve')) { const { signed } = await body(request, ['signed']); return send(200, await audit.approve(actor, signed)); }
      if (url.pathname.endsWith('/revoke')) return send(200, await audit.revoke(actor, await body(request, ['id'])));
      return send(200, await audit.query(actor, await body(request, null), url.pathname.endsWith('/export') ? 'export' : 'query'));
    }
    if(packUses&&request.method==='POST'&&url.pathname.startsWith('/v2/builders/pack-uses/')){
      const method={'events':'submit','read':'get','query':'query','candidates':'candidates','receipt':'receipt'}[url.pathname.slice('/v2/builders/pack-uses/'.length)];
      if(method){const actor=await authenticate(request,access,'builders',['get','query'].includes(method)),input=method==='submit'?await body(request,['consentId','payloadJson']):await body(request);
        return send(200,await packUses[method](actor?{...actor,httpRequestId:requestId}:null,input));}
    }
    if(builders?.v2&&request.method==='POST'&&url.pathname==='/v2/builders/pack/manifest'){
      const actor=await authenticate(request,access,'builders',true);return send(200,await builders.v2.manifest(actor,await body(request)));
    }
    if(builders?.v2&&request.method==='POST'&&['/v2/builders/support/read','/v2/builders/support/events','/v2/builders/pack/export'].includes(url.pathname)){
      const writing=url.pathname.endsWith('/events'),actor=await authenticate(request,access,'builders',!writing);
      const input=writing?await body(request,['consentId','payloadJson']):await body(request);
      return send(200,writing?await builders.v2.publish({...actor,httpRequestId:requestId},input)
        :url.pathname.endsWith('/export')?await builders.v2.exportPack(actor,input):await builders.v2.get(actor,input));
    }
    if(builders&&request.method==='POST'&&url.pathname==='/v1/builders/node-control/export'){
      const actor=await authenticate(request,access,'builders');return send(200,await builders.exportNodeControl({...actor,httpRequestId:requestId},await body(request,['builderId','controlId'])));
    }
    if (builders && request.method === 'POST' && ['/v1/builders/specification','/v1/builders/events','/v1/builders/read','/v1/builders/query','/v1/builders/reports/export','/v1/builders/manage/read','/v1/builders/owned/query','/v1/builders/events/receipt','/v1/builders/notices/query'].includes(url.pathname)) {
      if(url.pathname.endsWith('/specification')){await body(request,[]);return send(200,builders.specification());}
      const writing=url.pathname.endsWith('/events'),exporting=url.pathname.endsWith('/reports/export'),managing=/\/(?:manage\/read|owned\/query|events\/receipt)$/.test(url.pathname),actor=await authenticate(request,access,'builders',!writing&&!exporting&&!managing);
      if(writing)return send(200,await builders.publish({...actor,httpRequestId:requestId},await body(request,['consentId','payloadJson'])));
      const input=await body(request,null);
      if(url.pathname.endsWith('/manage/read'))return send(200,await builders.manage(actor,input));
      if(url.pathname.endsWith('/owned/query'))return send(200,await builders.owned(actor,input));
      if(url.pathname.endsWith('/events/receipt'))return send(200,await builders.receipt(actor,input));
      if(url.pathname.endsWith('/notices/query'))return send(200,await builders.notices(actor,input));
      if(exporting)return send(200,await builders.exportReport({...actor,httpRequestId:requestId},input));
      return send(200,url.pathname.endsWith('/read')?await builders.get(actor,input):await builders.query(actor,input));
    }
    if (capsules && request.method === 'POST' && ['/v1/capsules/events','/v1/capsules/uses','/v1/capsules/read','/v1/capsules/query','/v1/capsules/uses/query'].includes(url.pathname)) {
      const writing=['/v1/capsules/events','/v1/capsules/uses'].includes(url.pathname);
      const actor=await authenticate(request,access,'capsules',!writing);
      if(writing){const input=await body(request,['consentId','payloadJson']),caller={...actor,httpRequestId:requestId};
        return send(200,url.pathname.endsWith('/events')?await capsules.publish(caller,input):await capsules.recordUse(caller,input));}
      const input=await body(request,null);
      if(url.pathname.endsWith('/query'))consumeSearchPage(actor,input.after);
      return send(200,url.pathname.endsWith('/read')?await capsules.get(actor,input):url.pathname.endsWith('/uses/query')?await capsules.uses(actor,input):await capsules.query(actor,input));
    }
    if (honor && (['POST /v1/honor/rules','POST /v1/honor/query','POST /v1/honor/ranking','POST /v1/honor/rule-history'].includes(route)
      || /^GET \/v1\/honor\/GUID[0-9A-Z]{28}\/[a-z0-9][a-z0-9._-]{0,79}\/[0-9]+(?:\.[0-9]+){0,2}$/.test(route))) {
      if (route.endsWith('/rules')) { await body(request, []); return send(200, await honor.list()); }
      if (route.endsWith('/rule-history'))return send(200,await honor.ruleHistory(await body(request,null)));
      if (route.endsWith('/ranking')) return send(200, await honor.ranking(await body(request, ['ruleId','ruleVersion'])));
      const actor = await authenticate(request, access, 'history', true), parts = url.pathname.split('/');
      return send(200, await honor.query(actor, request.method === 'GET'
        ? {subjectId:parts[3],ruleId:parts[4],ruleVersion:parts[5]} : await body(request, null)));
    }
    if (moderation && request.method === 'POST' && (/^\/v1\/moderation\/(config|reports|reports\/query)$/.test(url.pathname)
      || /^\/v1\/moderation\/reports\/[0-9a-f-]{36}\/(read|events)$/.test(url.pathname))) {
      const actor = { ...await authenticate(request, access, 'moderation'), httpRequestId: requestId };
      if (url.pathname.endsWith('/config')) { await body(request, []); return send(200, await moderation.config(actor)); }
      if (url.pathname.endsWith('/query')) return send(200, await moderation.query(actor, await body(request, null)));
      const id = url.pathname.split('/')[4];
      if (url.pathname.endsWith('/read')) { await body(request, []); return send(200, await moderation.get(actor, id)); }
      const input = await body(request, ['consentId', 'payloadJson']);
      return send(200, id ? await moderation.event(actor, id, input) : await moderation.report(actor, input));
    }
    if (qualification && request.method==='POST' && ['/v1/qualification/policies','/v1/qualification/evaluate'].includes(url.pathname)) {
      const actor=await authenticate(request,access,'assistance');
      if(url.pathname.endsWith('/policies')){await body(request,[]);return send(200,await qualification.list(actor));}
      return send(200,await qualification.evaluate(actor,await body(request,null)));
    }
    if (notifications && request.method === 'POST' && ['/v1/notifications/query','/v1/notifications/preferences/read',
      '/v1/notifications/preferences/save','/v1/notifications/read','/v1/notifications/archive'].includes(url.pathname)) {
      const actor = { ...await authenticate(request, access, 'notifications'), httpRequestId: requestId };
      if (url.pathname.endsWith('/preferences/read')) { await body(request, []); return send(200, await notifications.preferences(actor)); }
      if (url.pathname.endsWith('/preferences/save')) return send(200, await notifications.save(actor, await body(request, ['expectedRevision','settings'])));
      if (url.pathname === '/v1/notifications/read') return send(200, await notifications.markRead(actor, await body(request, ['id'])));
      if (url.pathname === '/v1/notifications/archive') return send(200, await notifications.archive(actor, await body(request, ['expectedRevision','before'])));
      return send(200, await notifications.query(actor, await body(request, null)));
    }
    if (assistance && route === 'POST /v1/requester-history/query')
      return send(200, await assistance.requesterHistory(await authenticate(request, access, 'assistance'), await body(request, null)));
    if (assistance && route === 'POST /v1/requester-history/facts')
      return send(200, await assistance.requesterHistoryFacts(await authenticate(request, access, 'assistance'), await body(request, null)));
    if (context && (route === 'POST /v1/context-grants' || route === 'POST /v1/context-grants/query' || route === 'POST /v1/context-grants/receipt'
      || /^GET \/v1\/context-grants\/[0-9a-f-]{36}$/.test(route)
      || /^POST \/v1\/context-grants\/[0-9a-f-]{36}\/(accept|revoke)$/.test(route))) {
      const actor = { ...await authenticate(request, access, 'context'), httpRequestId: requestId }, id = url.pathname.split('/')[3];
      if (request.method === 'GET') return send(200, await context.get(actor, id));
      if (route.endsWith('/query')) return send(200, await context.query(actor, await body(request, ['assistanceId'])));
      if (route.endsWith('/receipt')) return send(200, await context.receipt(actor, await body(request, null)));
      if (route.endsWith('/revoke')) { await body(request, []); return send(200, await context.revoke(actor, id)); }
      const input = await body(request, ['consentId', 'payloadJson']);
      return send(200, route === 'POST /v1/context-grants' ? await context.create(actor, input) : await context.accept(actor, id, input));
    }
    if (assistance && (route === 'POST /v1/assistance' || route === 'POST /v1/assistance/query' || route === 'POST /v1/assistance/events/receipt' || /^GET \/v1\/assistance\/[0-9a-f-]{36}$/.test(route)
      || /^POST \/v1\/assistance\/[0-9a-f-]{36}\/events$/.test(route))) {
      const actor = { ...await authenticate(request, access, 'assistance'), httpRequestId: requestId };
      if (route === 'POST /v1/assistance/query') return send(200, await assistance.query(actor, await body(request, null)));
      if (route === 'POST /v1/assistance/events/receipt') return send(200, await assistance.receipt(actor, await body(request, null)));
      if (request.method === 'GET') return send(200, await assistance.get(actor, url.pathname.split('/')[3]));
      const input = await body(request, ['consentId', 'payloadJson']);
      return send(200, route === 'POST /v1/assistance' ? await assistance.create(actor, input)
        : await assistance.submit(actor, url.pathname.split('/')[3], input));
    }
    if (history && (route === 'POST /v1/history/query' || /^GET \/v1\/profiles\/GUID[0-9A-Z]{28}$/.test(route))) {
      const actor = await authenticate(request, access, 'history', true);
      const input=request.method==='GET'?{subjectId:url.pathname.split('/')[3]}:await body(request,null);
      consumeSearchPage(actor,input.after);
      return send(200, await history.query(actor,input));
    }
    const consentList = request.method === 'GET' && url.pathname === '/v1/consents';
    if (docsMcp && url.pathname === '/mcp/docs') {
      if (request.headers.host !== new URL(bindings.endpoint).host) throw new ServiceError('invalid_host', 403);
      if (request.method !== 'POST') throw new ServiceError('method_not_allowed', 405);
      return await docsMcp(request, response, await body(request, null));
    }
    if (keyring && route === 'GET /.well-known/galaxy-signing-keys.json') return send(200, keyring);
    if (manifest && route === 'GET /.well-known/galaxy-network.json') {
      const result = await manifest.get();
      response.setHeader('ETag', result.etag);
      response.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
      if (request.headers['if-none-match'] === result.etag) { response.statusCode = 304; response.end(); return; }
      return send(200, result.document);
    }
    if (manifest && route === 'GET /v1/policy') return send(200, manifest.data.policy);
    if (manifest && route === 'GET /v1/signing-keys/status') return send(200, {
      keys: [...bindings.trustedKeys].map(([kid, key]) => ({ kid, revoked: key.revoked,
        notBefore: key.notBefore, notAfter: key.notAfter })),
      trustSource: 'client-pinned-configuration', checkedAt: bindings.now() });
    if (route === 'POST /v1/binding-challenges') return send(201, await bindings.challenge(await body(request,
      ['subjectId', 'genesisProof', 'installationId', 'scopes'])));
    if (route === 'POST /v1/bindings') return send(200, await bindings.bind(await body(request,
      ['challenge', 'signature', 'clientSession']), { httpRequestId: requestId }));
    if (route === 'POST /v1/session-challenges') return send(201, await access.challenge(await body(request,
      ['bindingId', 'credentialHash'])));
    if (route === 'POST /v1/sessions') return send(200, await access.activate(await body(request,
      ['challenge', 'signature']), { httpRequestId: requestId }));
    if (proofs && (route === 'POST /v1/proof-previews' || route === 'POST /v1/proofs'
      || /^(GET|POST) \/v1\/proofs\/[0-9a-f-]{36}(\/status|\/revoke)?$/.test(route))) {
      const actor = await authenticate(request, access, 'proof', true);
      const parts = url.pathname.split('/');
      if (request.method === 'GET' && parts[4] !== 'revoke') return send(200, await proofs.get(actor, parts[3], parts[4] === 'status'));
      if (!actor) throw new ServiceError('access_denied', 401);
      if (route === 'POST /v1/proof-previews') return send(200, await proofs.preview(actor, await body(request, ['id', 'evidenceId'])));
      if (route === 'POST /v1/proofs') return send(200, await proofs.publish({ ...actor, httpRequestId: requestId }, await body(request, ['consentId', 'payloadJson'])));
      if (request.method === 'POST' && parts[4] === 'revoke') {
        await body(request, []); return send(200, await proofs.revoke({ ...actor, httpRequestId: requestId }, parts[3]));
      }
      throw new ServiceError('not_found', 404);
    }
    if (evidence && (route === 'POST /v1/evidence-submissions' || /^GET \/v1\/verifications\/[0-9a-f-]{36}$/.test(route))) {
      const actor = await authenticate(request, access, 'evidence');
      if (request.method === 'GET') return send(200, await evidence.get(actor, url.pathname.split('/')[3]));
      return send(202, await evidence.submit({ ...actor, httpRequestId: requestId }, await body(request, ['consentId', 'payloadJson'])));
    }
    if (cases && (route === 'POST /v1/cases' || route === 'POST /v1/case-events'
      || /^GET \/v1\/cases\/[0-9a-f-]{36}$/.test(route))) {
      const actor = { ...await authenticate(request, access, 'case-teaser'), httpRequestId: requestId };
      if (request.method === 'GET') return send(200, await cases.get(actor, url.pathname.split('/')[3]));
      const input = await body(request, ['consentId', 'payloadJson']);
      let kind;
      try { kind = JSON.parse(input.payloadJson).kind; } catch { throw new ServiceError('invalid_case_payload'); }
      if ((route === 'POST /v1/cases') !== (kind === 'case')) throw new ServiceError('invalid_case_route');
      return send(200, await cases.submit(actor, input));
    }
    if (consents && (consentList || route === 'POST /v1/consents' || /^POST \/v1\/consents\/[0-9a-f-]{36}\/revoke$/.test(route))) {
      const actor = await authenticate(request, access, 'consent');
      if (consentList) return send(200, await consents.list(actor, url.searchParams.get('after')));
      if (route === 'POST /v1/consents') {
        const input = await body(request, ['signedIntent']); return send(200, await consents.create({ ...actor, httpRequestId: requestId }, input.signedIntent));
      }
      await body(request, []); return send(200, await consents.revoke({ ...actor, httpRequestId: requestId }, url.pathname.split('/')[3]));
    }
    const match = /^\/v1\/bindings\/([0-9a-f-]{36})(\/revoke)?$/.exec(url.pathname);
    if (match && ((request.method === 'GET' && !match[2]) || (request.method === 'POST' && match[2]))) {
      const actor = await authenticate(request, access, 'binding');
      if (match[2]) {
        await body(request, []);
        return send(200, await bindings.revoke(match[1], actor.subjectId, requestId, requestId, actor));
      }
      return send(200, await bindings.get(match[1], actor.subjectId));
    }
    throw new ServiceError('not_found', 404);
  };
}
