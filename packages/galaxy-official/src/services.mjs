import { CommunityForumV1 } from "./community/community-forum-v1.mjs";
import {ReadingBookmarksV1} from "./accounts/reading-bookmarks-v1.mjs";
import {TaskMaterialServiceV1} from "./tasks/v2/material-v1.mjs";
import { CommunityForumGovernanceV1 } from "./community/community-forum-governance-v1.mjs";
import { BuilderService } from "./builders/service.mjs";
import { BuilderSupportV2Service } from "./builders/builder-support-v2.mjs";
import { WorkerPackUseServiceV2 } from "./projects/worker-pack-uses-v2.mjs";
import { IdentityLinkService } from "./identity/links.mjs";
import {IdentityGroupServiceV2} from "./identity/group-v2.mjs";
import {createIdentityGroupSourceReader} from "./identity/group-source-v2.mjs";
import {AccountWorkService} from "./accounts/work.mjs";
import { CommunityAccountRegistry } from "./accounts/community-accounts.mjs";
import { PublicWriteService } from "./publishing/public-writes.mjs";
import { IdentityControlService } from "./identity/control.mjs";
import { VerificationRecordService } from "./evidence/verification-records.mjs";
import { DataExportService } from "./privacy/data-export.mjs";
import { DeletionService } from "./privacy/deletion.mjs";
import { createRetirementController } from "./privacy/retirement.mjs";
import { AuditService } from "./audit/audit.mjs";
import { CapsuleService } from "./capsules/capsules.mjs";
import { CapsuleServiceV2 } from "./capsules/v2/service.mjs";
import { HonorService } from "./records/honor.mjs";
import { HonorV2Service } from "./records/honor-v2.mjs";
import { ContributionSharingV2Service } from "./evidence/contribution-sharing-v2.mjs";
import { RequesterHistoryV2Service } from "./records/requester-history-v2.mjs";
import { ModerationService } from "./governance/moderation.mjs";
import { QualificationService } from "./qualifications/qualification.mjs";
import { NotificationService } from "./notifications/notifications.mjs";
import { HistoryService } from "./records/history.mjs";
import { HistoryV2Service } from "./records/history-v2.mjs";
import { SearchService } from "./discovery/search.mjs";
import { SearchV2Service } from "./discovery/search-v2.mjs";
import {InformationServiceV2} from "./information/information-v2.mjs";
import {InformationWatchServiceV2} from "./information/information-watches-v2.mjs";
import { ChoiceSnapshotServiceV2 } from "./tasks/v2/choice-snapshots-v2.mjs";
import { createReceiptStatusService } from "./verification/receipt-status.mjs";
import { ChoiceSourceReaderV2 } from "./tasks/v2/choice-source-reader-v2.mjs";
import { SearchIndex } from "./discovery/search-index.mjs";
import { ProfileService } from "./profiles/profile.mjs";
import { DiscoveryService } from "./discovery/discovery.mjs";
import { DiscoveryV2Service } from "./discovery/discovery-v2.mjs";
import { ContextService } from "./context/context.mjs";
import { ContextServiceV2 } from "./context/context-v2.mjs";
import { AssistanceService } from "./assistance/assistance.mjs";
import { githubEvidenceSource } from "./evidence/github-evidence.mjs";
import { BindingService } from "./identity/bindings.mjs";
import { AccessService } from "./security/access.mjs";
import { ConsentService } from "./consents/consents.mjs";
import { CaseService } from "./cases/index.mjs";
import { EvidenceService } from "./evidence/evidence.mjs";
import { ProofService } from "./evidence/proofs.mjs";
import { ManifestService } from './manifest.mjs';
import { createSigningService } from "./security/signing-service.mjs";
import { ChatService } from "./chat/service.mjs";
import {ChatAttachmentsService} from "./chat/chat-attachments.mjs";
import {ForumAttachmentsV1Service} from "./community/forum-attachments-v1.mjs";
import { ServiceError } from './shared/service-error.mjs';
import {WatchControlV2Service} from "./information/watch-control-v2.mjs";
import { OutcomeMaterialServiceV2 } from "./evidence/outcome-material-v2.mjs";
import { NotificationInboxService } from "./notifications/notification-inbox.mjs";
import { ModerationNotificationAdapter } from "./notifications/moderation-notifications.mjs";
import { PersonalSummaryService, createSummarySourceReader } from "./summaries/personal-summaries.mjs";
import { ProjectV2Service } from "./projects/projects-v2.mjs";
import { ContactV2Service } from "./projects/contacts-v2.mjs";
import { createChatContactAdapter } from "./chat/chat-contact-adapter.mjs";
import { ExperienceReviewService } from "./evidence/experience-review.mjs";
import { QualificationCalculationService } from "./qualifications/qualification-calculation.mjs";
import {QualificationRequestServiceV2} from "./qualifications/qualification-requests-v2.mjs";
import { QualificationV2Service } from "./qualifications/qualification-v2.mjs";
import { ChatSharedSummaryService } from "./chat/chat-shared-summaries.mjs";
import { RecruitmentV2Service } from "./projects/recruitment-v2.mjs";
import { CiObservationV2Service } from "./evidence/ci-observation-v2.mjs";
import { TaskCommentServiceV2 } from "./tasks/v2/comments-v2.mjs";
import { TaskOwnerReadServiceV2 } from "./tasks/v2/owner-read-v2.mjs";
import { TaskOwnerControlServiceV2 } from "./tasks/v2/owner-control-v2.mjs";
import { CommentGovernanceServiceV2 } from "./governance/comment-governance-v2.mjs";
import { TargetGovernanceServiceV2 } from "./governance/target-governance-v2.mjs";
import { ConfigurationServiceV2 } from "./context/configurations-v2.mjs";
import { createFactSourceRouter } from "./evidence/fact-source-router-v2.mjs";
import { TrustPackagePermissionService } from "./verification/trust-package-permissions.mjs";
import {HubServiceV2} from "./network/hubs-v2.mjs";
import {HubPeeringServiceV2} from "./network/hub-peering-v2.mjs";
import {postHubPeeringJson} from "./infrastructure/public-fetch.mjs";
import { verifyEnvelope } from "./security/signed-envelope.mjs";

export function createServices({ db, endpoint, signingKey, kid, trustedKeys,
  now = () => Math.floor(Date.now() / 1000), operator, region, manifestProfile = {}, resourceBudgetPolicy, communityPolicy, forumPolicy, incident=null, identityProviders = [], officialAccounts = null, externalCredentials = null, chatTransport = null, attachmentConfiguration=null, experienceReviewers = [],
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
  const accountWork=new AccountWorkService(access,{accounts:communityAccounts});
  const publicWrites = new PublicWriteService(access, communityAccounts, communityPolicy);
  const forum = new CommunityForumV1(access,consents,{accounts:communityAccounts,publicWrites,policy:forumPolicy});
  forum.accessRules.externalCredentials=externalCredentials;
  const forumGovernance = new CommunityForumGovernanceV1(access,consents,forum,{accounts:communityAccounts,moderatorIds});
  const profiles=new ProfileService(access,consents);
  const evidence = new EvidenceService(access, consents, { source: evidenceSource, lockEvidenceWrite: repositories.lockEvidenceWrite });
  const proofs = new ProofService(access, consents, evidence, { sign: proofSigner.sign, lockEvidenceRead: repositories.lockEvidenceRead });
  const capsules = new CapsuleService(access, consents, proofs);
  const cases = new CaseService(access, consents); cases.capsules = capsules;
  const assistance = new AssistanceService(access, consents);
  const taskMaterials=new TaskMaterialServiceV1(access,consents,{forum});assistance.taskMaterials=taskMaterials;
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
  const contributionSharing = new ContributionSharingV2Service(access, consents,{taskMaterials});
  const honor = new HonorService(access, assistance, proofs, honorRules);
  honor.v2 = new HonorV2Service(honor, { qualification: qualification.v2, sharing: contributionSharing, ciV2 });
  forum.accessRules.honor=honor.v2;
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
  const chat = new ChatService({ db, access, accounts:communityAccounts, transport: chatTransport, now,
    resolveControlParty: async (tx, subjectId) => {
      if(subjectId.startsWith('account:'))return subjectId;
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
  const forumAttachments=new ForumAttachmentsV1Service({forum,...attachmentConfiguration});
  forum.attachments=forumAttachments;
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
  const readingBookmarks = new ReadingBookmarksV1(access, {forum, capsules: capsules.v2, projects, profiles,accounts:communityAccounts,chat});
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
  return { officialAccounts,externalCredentials,accountWork,readingBookmarks,taskMaterials,forum,forumAttachments,forumGovernance,taskOwnerControl,taskOwnerRead,targetGovernance,information,informationWatches,packUses, hubs, peering, trustPackages, qualificationRequests, attachments, outcomeMaterials, configurations, choices, comments, commentGovernance, ciV2, contextV2, contributionSharing, requesterHistoryV2, recruitment, sharedSummaries, experienceReviews, qualificationCalculations, discovery, projects, contacts, inbox, summaries, search, incident, profiles, builders, capsules, honor, bindings, access, consents, evidence, assistance, context, qualification, moderation, notifications, history, cases,
    identity: new IdentityLinkService(access, identityProviders, { accountRegistry: communityAccounts }), communityAccounts, publicWrites, verificationRecords, chat,
    receiptStatus,watchControls,identityGroups,identityControl: new IdentityControlService({ db, endpoint, now, allowedScopes }),
    proofs, retirement, deletion: new DeletionService(access), dataExport: new DataExportService(access, { forum,forumGovernance, choices, assistance, context, proofs, capsules, builders, moderation, cases, verificationRecords, projects, contacts, summaries, recruitment, outcomeMaterials }, retirement), audit: new AuditService(access, { auditReaderIds, auditReviewerIds }),
    manifest: new ManifestService({ ...manifestProfile, endpoint, kid, now, signer: manifestSigner, operator, region, capabilities }) };
}
