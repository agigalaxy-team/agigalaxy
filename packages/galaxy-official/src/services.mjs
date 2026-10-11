import { CommunityForumV1 } from './community-forum-v1.mjs';
import { CommunityForumGovernanceV1 } from './community-forum-governance-v1.mjs';
import { BuilderService } from './builders.mjs';
import { BuilderSupportV2Service } from './builder-support-v2.mjs';
import { WorkerPackUseServiceV2 } from './worker-pack-uses-v2.mjs';
import { IdentityLinkService } from './identity-links.mjs';
import {IdentityGroupServiceV2} from './identity-group-v2.mjs';
import {createIdentityGroupSourceReader} from './identity-group-source-v2.mjs';
import { CommunityAccountRegistry } from './community-accounts.mjs';
import { PublicWriteService } from './public-writes.mjs';
import { IdentityControlService } from './identity-control.mjs';
import { VerificationRecordService } from './verification-records.mjs';
import { DataExportService } from './data-export.mjs';
import { DeletionService } from './deletion.mjs';
import { createRetirementController } from './retirement.mjs';
import { AuditService } from './audit.mjs';
import { CapsuleService } from './capsules.mjs';
import { CapsuleServiceV2 } from './capsules-v2.mjs';
import { HonorService } from './honor.mjs';
import { HonorV2Service } from './honor-v2.mjs';
import { ContributionSharingV2Service } from './contribution-sharing-v2.mjs';
import { RequesterHistoryV2Service } from './requester-history-v2.mjs';
import { ModerationService } from './moderation.mjs';
import { QualificationService } from './qualification.mjs';
import { NotificationService } from './notifications.mjs';
import { HistoryService } from './history.mjs';
import { HistoryV2Service } from './history-v2.mjs';
import { SearchService } from './search.mjs';
import { SearchV2Service } from './search-v2.mjs';
import {InformationServiceV2} from './information-v2.mjs';
import {InformationWatchServiceV2} from './information-watches-v2.mjs';
import { ChoiceSnapshotServiceV2 } from './choice-snapshots-v2.mjs';
import { createReceiptStatusService } from './receipt-status.mjs';
import { ChoiceSourceReaderV2 } from './choice-source-reader-v2.mjs';
import { SearchIndex } from './search-index.mjs';
import { ProfileService } from './profile.mjs';
import { DiscoveryService } from './discovery.mjs';
import { DiscoveryV2Service } from './discovery-v2.mjs';
import { ContextService } from './context.mjs';
import { ContextServiceV2 } from './context-v2.mjs';
import { AssistanceService } from './assistance.mjs';
import { githubEvidenceSource } from './github-evidence.mjs';
import { BindingService } from './bindings.mjs';
import { AccessService } from './access.mjs';
import { ConsentService } from './consents.mjs';
import { CaseService } from './cases.mjs';
import { EvidenceService } from './evidence.mjs';
import { ProofService } from './proofs.mjs';
import { ManifestService } from './manifest.mjs';
import { createSigningService } from './signing-service.mjs';
import { ChatService } from './chat.mjs';
import {ChatAttachmentsService} from './chat-attachments.mjs';
import { ServiceError } from './shared/service-error.mjs';
import {WatchControlV2Service} from './watch-control-v2.mjs';
import { OutcomeMaterialServiceV2 } from './outcome-material-v2.mjs';
import { NotificationInboxService } from './notification-inbox.mjs';
import { ModerationNotificationAdapter } from './moderation-notifications.mjs';
import { PersonalSummaryService, createSummarySourceReader } from './personal-summaries.mjs';
import { ProjectV2Service } from './projects-v2.mjs';
import { ContactV2Service } from './contacts-v2.mjs';
import { createChatContactAdapter } from './chat-contact-adapter.mjs';
import { ExperienceReviewService } from './experience-review.mjs';
import { QualificationCalculationService } from './qualification-calculation.mjs';
import {QualificationRequestServiceV2} from './qualification-requests-v2.mjs';
import { QualificationV2Service } from './qualification-v2.mjs';
import { ChatSharedSummaryService } from './chat-shared-summaries.mjs';
import { RecruitmentV2Service } from './recruitment-v2.mjs';
import { CiObservationV2Service } from './ci-observation-v2.mjs';
import { TaskCommentServiceV2 } from './task-comments-v2.mjs';
import { TaskOwnerReadServiceV2 } from './task-owner-read-v2.mjs';
import { TaskOwnerControlServiceV2 } from './task-owner-control-v2.mjs';
import { CommentGovernanceServiceV2 } from './comment-governance-v2.mjs';
import { TargetGovernanceServiceV2 } from './target-governance-v2.mjs';
import { ConfigurationServiceV2 } from './configurations-v2.mjs';
import { createFactSourceRouter } from './fact-source-router-v2.mjs';
import { TrustPackagePermissionService } from './trust-package-permissions.mjs';
import {HubServiceV2} from './hubs-v2.mjs';
import {HubPeeringServiceV2} from './hub-peering-v2.mjs';
import {postHubPeeringJson} from './public-fetch.mjs';
import { verifyEnvelope } from './signed-envelope.mjs';

export function createServices({ db, endpoint, signingKey, kid, trustedKeys,
  now = () => Math.floor(Date.now() / 1000), operator, region, manifestProfile = {}, resourceBudgetPolicy, communityPolicy, forumPolicy, incident=null, identityProviders = [], chatTransport = null, attachmentConfiguration=null, experienceReviewers = [],
  allowedScopes = ['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history', 'assistance', 'context', 'notifications', 'moderation', 'capsules', 'builders', 'audit', 'audit-review', 'data-export', 'data-delete'],
  capabilities = ['binding', 'sessions', 'docs-mcp'], auditReaderIds = [], auditReviewerIds = [], qualificationPolicies = [], moderatorIds = [], honorRules = [], builderAssessorIds = [], conformanceSuitePins = [], consentPolicy, repositories = {}, evidenceSource = githubEvidenceSource, retirement = createRetirementController(null, { endpoint, now }) }) {
  const signing = { endpoint, signingKey, kid, trustedKeys, now };
  const bindingSigner = createSigningService(signing, ['binding-challenge', 'binding-receipt']);
  const sessionSigner = createSigningService(signing, ['session-challenge']);
  const proofSigner = createSigningService(signing, ['proof']);
  const conformanceSigner = createSigningService(signing, ['conformance', 'node-control']);
  const manifestSigner = createSigningService(signing, ['manifest']);
  const peeringSigner = createSigningService(signing, ['hub-peering']);
  const bindings = new BindingService({ db, endpoint, kid, trustedKeys, now, allowedScopes, signer: bindingSigner, readSubject: repositories.readSubject,
    retirement:{async assertBindingSubject(tx,subjectId){await retirement?.assertBindingSubject(tx,subjectId);await incident?.assertBindingSubject(tx,subjectId);}} });
  const access = new AccessService({ db, endpoint, now, trustedKeys, sign: sessionSigner.sign, resourceBudgetPolicy });
  const consents = new ConsentService(access, { additionalPolicy: consentPolicy });
  const communityAccounts = new CommunityAccountRegistry(access, identityProviders);
  const publicWrites = new PublicWriteService(access, communityAccounts, communityPolicy);
  const forum = new CommunityForumV1(access,consents,{accounts:communityAccounts,publicWrites,policy:forumPolicy});
  const forumGovernance = new CommunityForumGovernanceV1(access,consents,forum,{accounts:communityAccounts,moderatorIds});
  const profiles=new ProfileService(access,consents);
  const evidence = new EvidenceService(access, consents, { source: evidenceSource, lockEvidenceWrite: repositories.lockEvidenceWrite });
  const proofs = new ProofService(access, consents, evidence, { sign: proofSigner.sign, lockEvidenceRead: repositories.lockEvidenceRead });
  const capsules = new CapsuleService(access, consents, proofs);
  const cases = new CaseService(access, consents); cases.capsules = capsules;
  const assistance = new AssistanceService(access, consents);
  const taskOwnerRead = new TaskOwnerReadServiceV2(access, consents);
  const taskOwnerControl = new TaskOwnerControlServiceV2(access, consents, {tasks:assistance,ownerRead:taskOwnerRead});
  assistance.publicWrites = publicWrites;
  assistance.communityAccounts = communityAccounts;
  cases.tasks = assistance;
  assistance.cases = cases;
  assistance.facts = cases;
  const verificationRecords = new VerificationRecordService(access, consents, { cases, tasks: assistance, proofs });
  evidence.records = verificationRecords;
  const configurations = new ConfigurationServiceV2(access, consents);
  cases.configurations = configurations;
  cases.verifications = verificationRecords;
  const ciV2 = new CiObservationV2Service(access, consents, { records: verificationRecords, sign: proofSigner.sign, verifyEnvelope, source: evidenceSource });
  verificationRecords.ciV2 = ciV2;
  const trustPackages = new TrustPackagePermissionService(access,{cases,verificationRecords,ciV2});
  const qualification = new QualificationService(access, proofs, assistance, qualificationPolicies);
  const experienceReviews = new ExperienceReviewService(access, consents, { reviewers: experienceReviewers,
    resolveControllerWithin: async (tx, subjectId) => {
      try { return (await communityAccounts.resolveWithin(tx, { subjectId })).id; }
      catch (error) { if (error.code === 'account_verification_required') return null; throw error; }
    } });
  const qualificationCalculations = new QualificationCalculationService(access, consents, assistance);
  qualification.v2 = new QualificationV2Service(qualification, { cases, assistance, experienceReviews, capsules, calculations: qualificationCalculations });
  assistance.qualification = qualification;
  const contributionSharing = new ContributionSharingV2Service(access, consents);
  const honor = new HonorService(access, assistance, proofs, honorRules);
  honor.v2 = new HonorV2Service(honor, { qualification: qualification.v2, sharing: contributionSharing, ciV2 });
  const requesterHistoryV2 = new RequesterHistoryV2Service(access, assistance, contributionSharing);
  const context = new ContextService(access, consents, assistance);
  const contextV2 = new ContextServiceV2(access, consents, assistance);
  const builders = new BuilderService(access,consents,proofs,builderAssessorIds,{suitePins:conformanceSuitePins,sign:conformanceSigner.sign});
  builders.v2 = new BuilderSupportV2Service(builders);
  const packUses = new WorkerPackUseServiceV2(access,consents,{builders:builders.v2,cases,configurations,verificationRecords});
  const hubs = new HubServiceV2(access, consents, builders);
  const peering = new HubPeeringServiceV2(hubs, { ciV2, sharing: contributionSharing, sign: peeringSigner.sign, send: postHubPeeringJson });
  const moderation = new ModerationService(access,consents,assistance,moderatorIds,evidence);
  proofs.moderation=moderation;
  const history=new HistoryService(access,consents,proofs,capsules,assistance,profiles,moderation);
  history.v2 = new HistoryV2Service(access, { cases, verificationRecords, assistance, profiles, capsules });
  const search=new SearchService(access,{history,proofs,capsules,builders,index:new SearchIndex({db,endpoint,now})});
  const notifications = new NotificationService(access, assistance, context, capsules, incident);
  const chat = new ChatService({ db, access, transport: chatTransport, now,
    resolveControlParty: async (tx, subjectId) => {
      try { return `account:${(await communityAccounts.resolveWithin(tx, { subjectId })).id}`; }
      catch (error) { if (error.code === 'account_verification_required') return `subject:${subjectId}`; throw error; }
    },
    requireAccountWithin: async (tx, actor) => {
      const account = await communityAccounts.resolveWithin(tx, actor);
      if (account.restricted_until && Date.parse(account.restricted_until) > now() * 1000) {
        throw new ServiceError('community_restricted', 403);
      }
      return account;
    },
    consumeInviteWithin: (tx, actor, input) => publicWrites.consumeWithin(tx, actor, { kind: 'invitation', operationId: input.eventId,
      payloadHash: input.payloadHash, roomId: input.roomId, recipientId: input.recipientId }),
    markInviteRespondedWithin: (tx, input) => publicWrites.markInvitationRespondedWithin(tx, input),
    validateTaskRef: (tx, actor, taskId) => assistance.requireTaskWithin(tx, actor, taskId),
  });
  const attachments=new ChatAttachmentsService({chat,...attachmentConfiguration});
  chat.attachments=attachments;
  const outcomeMaterials=new OutcomeMaterialServiceV2(access,{consents,chat,records:verificationRecords,attachments});
  const watchControls=new WatchControlV2Service(access,{chat,assistance});
  cases.sources = createFactSourceRouter({verificationRecords,configurations,chat,outcomeMaterials});
  capsules.v2 = new CapsuleServiceV2(capsules, { cases, verificationRecords, configurations, outcomeMaterials,
    readSelectedWithin: (tx, actor, ref) => chat.readSelectedWithin(tx, actor, ref) });
  const discovery = new DiscoveryService(access, profiles, notifications);
  const inbox = new NotificationInboxService({ access, notifications, chat, tasks: assistance,
    moderationNotifications: new ModerationNotificationAdapter(moderation) });
  const qualificationRequests=new QualificationRequestServiceV2(access,consents,{qualification:qualification.v2,calculations:qualificationCalculations,tasks:assistance,inbox});
  inbox.qualificationRequests=qualificationRequests;
  const comments = new TaskCommentServiceV2(access, consents, assistance, { accounts: communityAccounts, publicWrites, inbox });
  const commentGovernance = new CommentGovernanceServiceV2(access, consents, comments, { accounts: communityAccounts, moderatorIds });
  inbox.comments = comments; inbox.commentGovernance = commentGovernance;
  const targetGovernance = new TargetGovernanceServiceV2(access, consents, {tasks:assistance,chat,accounts:communityAccounts,moderatorIds});
  const identityGroups=new IdentityGroupServiceV2(access,{readSourceWithin:createIdentityGroupSourceReader({cases,configurations})});
  inbox.targetGovernance=targetGovernance;
  const summaries = new PersonalSummaryService({ db, access, endpoint, sourceReader: createSummarySourceReader(chat) });
  const sharedSummaries = new ChatSharedSummaryService({ db, access, chat });
  const projects = new ProjectV2Service(access, { consents, profiles, notifications,
    requireAccountWithin: (tx, actor) => communityAccounts.resolveWithin(tx, actor) });
  discovery.v2 = new DiscoveryV2Service(access, { profiles, projects, inbox, notifications, history: history.v2 });
  const recruitment = new RecruitmentV2Service(access, { projects, consents, discovery: discovery.v2, assistance, inbox, publicWrites });
  discovery.v2.recruitment = recruitment;
  search.v2 = new SearchV2Service(access, { history: history.v2, capsules: capsules.v2, ciV2, assistance, discovery: discovery.v2, legacy: search });
  const choices = new ChoiceSnapshotServiceV2(access,{sourceReader:new ChoiceSourceReaderV2(search.v2)});
  const receiptStatus = createReceiptStatusService({db,endpoint,signingKey,kid,trustedKeys,now,retirement,choiceSnapshots:choices});
  const information=new InformationServiceV2(access,{search:search.v2,honor:honor.v2});
  const informationWatches=new InformationWatchServiceV2(access,{information,retirement});
  inbox.informationWatches=informationWatches;
  const contacts = new ContactV2Service(access, { consents, discovery: discovery.v2, inbox, publicWrites,
    requireAccountWithin: (tx, actor) => communityAccounts.resolveWithin(tx, actor), createRoomWithin: createChatContactAdapter(chat) });
  return { forum,forumGovernance,taskOwnerControl,taskOwnerRead,targetGovernance,information,informationWatches,packUses, hubs, peering, trustPackages, qualificationRequests, attachments, outcomeMaterials, configurations, choices, comments, commentGovernance, ciV2, contextV2, contributionSharing, requesterHistoryV2, recruitment, sharedSummaries, experienceReviews, qualificationCalculations, discovery, projects, contacts, inbox, summaries, search, incident, profiles, builders, capsules, honor, bindings, access, consents, evidence, assistance, context, qualification, moderation, notifications, history, cases,
    identity: new IdentityLinkService(access, identityProviders, { accountRegistry: communityAccounts }), communityAccounts, publicWrites, verificationRecords, chat,
    receiptStatus,watchControls,identityGroups,identityControl: new IdentityControlService({ db, endpoint, now, allowedScopes }),
    proofs, retirement, deletion: new DeletionService(access), dataExport: new DataExportService(access, { forum,forumGovernance, choices, assistance, context, proofs, capsules, builders, moderation, cases, verificationRecords, projects, contacts, summaries, recruitment, outcomeMaterials }, retirement), audit: new AuditService(access, { auditReaderIds, auditReviewerIds }),
    manifest: new ManifestService({ ...manifestProfile, endpoint, kid, now, signer: manifestSigner, operator, region, capabilities }) };
}
