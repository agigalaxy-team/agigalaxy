package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountsocial"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/choices"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/credentials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discoveryconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/experiencereviews"
	"github.com/agigalaxy-team/agigalaxy/go/internal/failureaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/honor"
	"github.com/agigalaxy-team/agigalaxy/go/internal/hubs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messagingconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationalmetrics"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsanalytics"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsjobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsresources"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsretention"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/personalaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/personalmcp"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publication"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"github.com/agigalaxy-team/agigalaxy/go/internal/requesterhistory"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/servicemetadata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/summaries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	"github.com/agigalaxy-team/agigalaxy/go/internal/targetgovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"github.com/agigalaxy-team/agigalaxy/go/internal/watchcontrol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/jackc/pgx/v5"
)

func serve(ctx context.Context, runtimeLog *runtimelog.Logger) (result error) {
	logger := slog.New(runtimeLog.Handler())
	started := false
	defer func() {
		if result != nil {
			event := "startup_failed"
			if started {
				event = "runtime_shutdown_failed"
			}
			logger.Error(event, "error", result)
		}
	}()
	if os.Geteuid() == 0 {
		return fault.New("non_root_runtime_required", 400)
	}
	release, e := runtimeconfig.RuntimeServiceRelease(os.Getenv, "api", "")
	if e != nil {
		return e
	}
	endpoint := os.Getenv("GALAXY_ENDPOINT")
	pool, e := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	if e = postgres.AssertRecoveryReady(ctx, pool); e != nil {
		return e
	}
	metricConfig, e := operationalmetrics.LoadConfiguration(os.LookupEnv)
	if e != nil {
		return e
	}
	metrics, e := operationalmetrics.New(operationalmetrics.Options{Component: "api", Configuration: metricConfig, Pool: pool, LogStatus: runtimeLog.Status})
	if e != nil {
		return e
	}
	var identityConfigurationHash string
	gateway, e := access.Load(ctx, pool, endpoint, os.Getenv("GALAXY_ACCOUNT_CONFIG_FILE"), os.Getenv("GALAXY_OPERATIONS_CONFIG_FILE"), os.Getenv("GALAXY_IDENTITY_CONFIG_FILE"), func(hash string) { identityConfigurationHash = hash })
	if e != nil {
		return e
	}
	boundaryConfiguration, requestQuotaHash, browserPolicyHash, e := loadHTTPBoundaryConfiguration(gateway)
	if e != nil {
		return e
	}
	files, e := attachments.LoadConfiguration(os.Getenv("GALAXY_ATTACHMENTS_CONFIG_FILE"), os.Getenv("CREDENTIALS_DIRECTORY"))
	if e != nil {
		return e
	}
	repository := &feedback.AttachmentRepository{Endpoint: endpoint}
	if files != nil {
		repository.Store = files.Store
		repository.Scanner = files.Scanner
		repository.Policy = files.Policy
		repository.DraftRetentionDays = files.DraftRetentionDays
		repository.SubmittedRetentionDays = files.SubmittedRetentionDays
	}
	service := &feedback.Service{Pool: pool, Endpoint: endpoint, Attachments: repository}
	credentialConfig, e := credentials.LoadConfiguration(os.Getenv("GALAXY_EXTERNAL_CREDENTIALS_CONFIG_FILE"))
	if e != nil {
		return e
	}
	externalCredentials, e := credentials.New(endpoint, credentialConfig, nil, nil, nil)
	if e != nil {
		return e
	}
	devices, e := loadDevices(ctx, pool, endpoint)
	if e != nil {
		return e
	}
	metadata, e := loadServiceMetadata(devices)
	if e != nil {
		return e
	}
	lifecycle, e := retirement.Load(os.Getenv("GALAXY_RETIREMENT_FILE"), retirement.Options{Endpoint: endpoint})
	if e != nil {
		return e
	}
	if devices != nil {
		lifecycle.BindDevice(devices)
	}
	incidentState, e := incident.Load(os.Getenv("GALAXY_INCIDENT_FILE"), incident.Options{Endpoint: endpoint})
	if e != nil {
		return e
	}
	if devices != nil {
		incidentState.BindDevice(devices)
	}
	accountService := &accounts.Service{Endpoint: endpoint}
	links := &accountlinks.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Accounts: accountService}
	for _, provider := range gateway.Config.IdentityProviders {
		links.Providers = append(links.Providers, accountlinks.Provider{Issuer: provider.Issuer, ClientID: provider.ClientID})
	}
	budgetPolicy, e := resourcebudget.Load(os.Getenv("GALAXY_RESOURCE_BUDGET_FILE"))
	if e != nil {
		return e
	}
	budget, e := resourcebudget.New(budgetPolicy, nil)
	if e != nil {
		return e
	}
	var governanceConfiguration community.GovernanceRuntime
	forum, e := loadCommunity(pool, endpoint, devices, links, budget, externalCredentials, func(value community.GovernanceRuntime) { governanceConfiguration = value })
	if e != nil {
		return e
	}
	startupForumPolicy, _ := forum.PolicySnapshot()
	var chatConfigurationHash *string
	chatService, closeChat, e := loadChat(ctx, pool, endpoint, devices, links, budget, forum, logger, func(hash *string) { chatConfigurationHash = hash })
	if e != nil {
		return e
	}
	defer closeChat()
	chatFiles := &chat.AttachmentService{Chat: chatService, Diagnostic: func(value chat.Object) {
		logger.Warn("attachment_processing_deferred", "code", value["code"], "stage", "chat-attachment")
	}}
	if files != nil {
		chatFiles.Store, chatFiles.Scanner, chatFiles.Policy = files.Store, files.Scanner, files.Policy
	}
	chatService.Attachments = chatFiles
	tasks, outcome, caseService, e := taskServices(pool, endpoint, devices, links, budget, forum, chatService, chatFiles, files)
	if e != nil {
		return e
	}
	evidenceService, proofs := evidenceServices(pool, endpoint, devices, budget, budgetPolicy, caseService)
	records := recordService(caseService, proofs)
	ci := ciService(records, caseService, proofs, budgetPolicy)
	ci.BudgetPolicyNow = budget.SnapshotPolicy
	policyRuntime, e := startAPIPolicies(ctx, gateway, budget, forum, tasks.Writes, logger)
	if e != nil {
		return e
	}
	defer policyRuntime.Stop()
	configurations, contextMaterials := selectedFactSources(caseService, tasks)
	buildersService, e := builderService(governanceConfiguration, caseService, records, proofs, configurations)
	if e != nil {
		return e
	}
	contributionService := &contributions.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Resources: budget, Tasks: tasks}
	capsuleSource := capsuleService(caseService, records, proofs, configurations, chatService, outcome)
	hostWatchControl := &watchcontrol.Service{Pool: pool, Devices: devices, Room: chatService.WatchRoomWithin, Agent: chatService.WatchAgentWithin, Task: tasks.ReadTaskWithin, ResourceWrite: watchcontrol.ResourceWrite(caseService.ResourceWrite)}
	identityGroups := &identitygroups.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: caseService, Configurations: configurations, ResourceWrite: identitygroups.ResourceWrite(caseService.ResourceWrite)}
	hubsService := &hubs.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Builders: buildersService, ResourceWrite: hubs.ResourceWrite(caseService.ResourceWrite)}
	hubPeering := &hubs.Peering{Hubs: hubsService, CI: ci, Sharing: contributionService}
	if devices != nil {
		if signer, ok := devices.Signer.(*deviceauth.SessionKeyring); ok {
			hubPeering.Pins = signer.Pins
			for _, key := range signer.SigningKeyStatuses() {
				hubPeering.PinOrder = append(hubPeering.PinOrder, key.KID)
			}
			hubPeering.Sign = func(ctx context.Context, kind string, data any, id string, ttl int64) (string, error) {
				if kind != "hub-peering" {
					return "", fault.New("signing_purpose_denied", 403)
				}
				return signer.SignHubPeering(ctx, data, id, time.Now().Unix(), ttl)
			}
		}
	}
	historyCurrent := currentHistory(caseService, tasks)
	historyCurrent.Records, historyCurrent.Proofs = records, proofs
	historyCurrent.CapsuleUses = capsuleSource.HistoryWireWithin
	inbox := &notifications.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Resources: budget, EvidenceBlocked: func() bool { return incidentState != nil && !incidentState.CanProcessEvidence() }}
	qualifications, e := qualificationService(ctx, governanceConfiguration, caseService, tasks, proofs, inbox, budget, true)
	if e != nil {
		return e
	}
	experience, e := experienceService(ctx, governanceConfiguration, qualifications, links, budget, true)
	if e != nil {
		return e
	}
	honors, e := honorService(ctx, governanceConfiguration, qualifications, tasks, proofs, contributionService, ci, true)
	if e != nil {
		return e
	}
	requesterHistory := &requesterhistory.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Sharing: contributionService}
	moderationService := &moderation.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: caseService, Assistance: tasks, Evidence: evidenceService, Resources: budget, ModeratorIDs: forum.ModeratorIDs}
	proofs.Moderation = moderationService.CaseContextWithin
	eventAuthority := access.NewWebEventAuthority(gateway)
	eventAuthority.Devices = devices
	eventAuthority.Public.Consumers = forum.EventConsumers()
	eventAuthority.Public.Consumers.Chat = chatService.EventRead()
	eventAuthority.Public.Consumers.Task = tasks.EventRead
	eventAuthority.Public.Consumers.PublicTask = tasks.PublicEventRead
	eventAuthority.Public.Consumers.Inbox = inbox.EventRead
	eventAuthority.DeviceAccountWithin = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, selected string) (string, error) {
		account, err := links.ResolveWithin(ctx, tx, actor, selected, false)
		if err != nil {
			return "", err
		}
		id, ok := account["id"].(string)
		if !ok || id == "" {
			return "", fault.New("account_authority_unavailable", 503)
		}
		return id, nil
	}
	events := &webevents.Service{Pool: pool, Endpoint: endpoint, Authority: eventAuthority}
	defer events.Stop()
	accountIdentity := accounts.HTTPIdentityFunc(func(r *http.Request, write bool) (string, accounts.Authorization, error) {
		id, a, e := gateway.Account(r, write)
		return id, a, e
	})
	chatHandler := chat.Handler{Service: chatService, Identity: chatIdentity{gateway}, Next: webevents.Handler{Service: events}}
	chatAttachmentHandler := chat.AttachmentHandler{Service: chatFiles, Identity: chatIdentity{gateway}, Next: chatHandler}
	sharedSummaries := &chat.SharedSummaryService{Chat: chatService}
	chatSharedHandler := chat.SharedSummaryHandler{Service: sharedSummaries, Next: chatAttachmentHandler}
	personalSummaries, e := summaries.New(pool, endpoint, devices, nil)
	if e != nil {
		return e
	}
	personalSummaries.Source, personalSummaries.ErasureSource, personalSummaries.Resources = chatService.SummarySourceWithin, chatService.SummaryErasureSourceWithin, budget
	identityProfiles := &profiles.Service{Pool: pool, Endpoint: endpoint, Devices: devices}
	legacyHistory := legacyHistoryProjection(identityProfiles, proofs)
	legacyHistory.Moderation, legacyHistory.CapsuleUses = moderationService.CaseContextWireWithin, capsuleSource.LegacyHistoryWireWithin
	legacySearch := legacySearchService(legacyHistory, proofs, buildersService, capsuleSource)
	historyCurrent.Profiles = identityProfiles
	projectService := &projects.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Links: links, Profiles: identityProfiles, Resources: budget}
	eventAuthority.Public.Consumers.Project = projectService.EventRead()
	contactDiscovery := &chat.ContactDiscovery{Endpoint: endpoint, Profiles: identityProfiles}
	contactDiscovery.UseProjects(projectService)
	recruitmentService := &recruitment.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Projects: projectService, Opportunities: contactDiscovery, Tasks: tasks, Inbox: inbox, PublicWrites: tasks.Writes, Resources: budget}
	contactDiscovery.RecruitmentOpportunity = recruitmentService.RequireContactOpportunityWithin
	contactDiscovery.Pool, contactDiscovery.Devices, contactDiscovery.History, contactDiscovery.Notifications, contactDiscovery.Recruitment = pool, devices, historyCurrent, inbox, recruitmentService
	search := searchService(historyCurrent, ci, tasks, contactDiscovery)
	search.Capsules = capsuleSource.QueryV2Wire
	search.Legacy = legacySearch.QueryWire
	choiceService := &choices.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Resources: budget, Sources: &choices.Reader{History: historyCurrent, Tasks: tasks, CI: ci, Capsules: capsuleSource.ReadV2WireWithin, Builders: buildersService.ReadChoiceWireWithin, Opportunities: contactDiscovery.ReadChoiceWireWithin, QueryOpportunities: contactDiscovery.QueryWireWithin}}
	informationService := &information.Service{Endpoint: endpoint, Search: search, Honor: honorInformationSource(honors)}
	informationWatches := &information.Watches{Pool: pool, Devices: devices, Information: informationService, ResourceWrite: information.ResourceWrite(caseService.ResourceWrite), CanProcessEvidence: func() bool { return incidentState == nil || incidentState.CanProcessEvidence() }}
	contactService := &chat.ContactService{Chat: chatService, Discovery: contactDiscovery}
	contactHandler := chat.ContactHandler{Service: contactService, Next: chatSharedHandler}
	projectHandler := projects.Handler{Service: projectService, Next: recruitment.Handler{Service: recruitmentService, Next: contactHandler}}
	targetGovernance := &targetgovernance.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Links: links, Tasks: tasks, Chat: chatService, Resources: budget, ModeratorIDs: forum.ModeratorIDs}
	forumFiles := &community.AttachmentService{Forum: forum, Diagnostic: func(value community.Object) {
		logger.Warn("attachment_processing_deferred", "code", value["code"], "stage", "forum-attachment")
	}}
	if files != nil {
		forumFiles.Store, forumFiles.Scanner, forumFiles.Policy = files.Store, files.Scanner, files.Policy
	}
	forumHandler := community.AttachmentHandler{Service: forumFiles, Identity: communityIdentity{gateway}, Next: community.Handler{Service: forum, Identity: communityIdentity{gateway}, Next: projectHandler}}
	fileGovernance := &filegovernance.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), PrincipalWithin: gateway.LockOperationsPrincipalWithin, Chat: chatFiles.GovernanceAdapter(), Forum: forumFiles.GovernanceAdapter(), Diagnostic: func(value filegovernance.Object) { logger.Warn("file_processing_deferred", "code", value["code"]) }}
	social := &accountsocial.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Links: links, Accounts: accountService, Resources: budget, Forum: forum, Profiles: accountsocial.ProfileSource(identityProfiles), Chat: chatBookmark(chatService)}
	var taskComments *taskmaterials.CommentService
	var commentGovernance *taskmaterials.CommentGovernance
	factHTTP := taskHandler(tasks, outcome, caseService, inbox, chatService, forum.ModeratorIDs, targetgovernance.Handler{Service: targetGovernance, Next: forumHandler}, func(comments *taskmaterials.CommentService, governance *taskmaterials.CommentGovernance) {
		taskComments, commentGovernance = comments, governance
	})
	factHTTP = opportunities.Handler{Service: contactDiscovery, Next: factHTTP}
	factHTTP = qualification.Handler{Service: qualifications, Next: factHTTP}
	factHTTP = experiencereviews.Handler{Service: experience, Next: factHTTP}
	factHTTP = moderation.Handler{Service: moderationService, Next: factHTTP}
	factHTTP = builders.Handler{Service: buildersService, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = hubs.Handler{Service: hubsService, Peering: hubPeering, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = contributions.Handler{Service: contributionService, Next: factHTTP}
	factHTTP = capsules.Handler{Service: capsuleSource, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = information.Handler{Service: informationService, Watches: informationWatches, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = watchcontrol.Handler{Service: hostWatchControl, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = identitygroups.Handler{Service: identityGroups, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = honor.Handler{Service: honors, Next: factHTTP}
	factHTTP = requesterhistory.Handler{Service: requesterHistory, Next: factHTTP}
	factHTTP = choices.Handler{Service: choiceService, Next: factHTTP}
	factHTTP = summaries.Handler{Service: personalSummaries, Next: factHTTP}
	factHTTP = discovery.LegacyHandler{Service: legacySearch, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = searchv2.Handler{Service: search, Devices: devices, ConsumeSearchPage: consumeFactSearchPage, Next: factHTTP}
	factHTTP = evidenceHandler(evidenceService, proofs, factHTTP)
	factHTTP = recordsHandler(records, factHTTP)
	factHTTP = ciHandler(ci, factHTTP)
	factHTTP = selectedFactHandler(configurations, contextMaterials, factHTTP)
	factHTTP = profileHandler(identityProfiles, proofs, factHTTP, profileSources{Current: historyCurrent, Moderation: moderationService.CaseContextWireWithin, CapsuleUses: capsuleSource.LegacyHistoryWireWithin, Legacy: legacyHistory})
	accountHandler := accounts.Handler{Service: accountService, Pool: pool, Identity: accountIdentity, Providers: gateway.Config.IdentityProviders, PublicPostsPage: forum.PublicForAccountWithin, PublicCredentialsPage: externalCredentials.PublicForAccountWithin, Next: socialHandler(social, accountIdentity, factHTTP)}
	inbox.Readers.TargetGovernance = targetGovernance.NotificationReadWithin
	inbox.Readers.Qualification = qualifications.NotificationReadWithin
	inbox.Readers.Moderation = moderationService.NotificationReadWithin
	inbox.Readers.Capsule = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, candidate notifications.Object) (notifications.Object, error) {
		eventID, _ := candidate["event_id"].(string)
		return capsuleSource.VisibleUpdateWithin(ctx, tx, actor, eventID)
	}
	inbox.Readers.Information = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, candidate notifications.Object) (notifications.Object, error) {
		eventID, _ := candidate["event_id"].(string)
		return informationWatches.NotificationWithin(ctx, tx, actor, eventID)
	}
	// Only an explicitly selected River endpoint may enqueue migrated jobs.
	// Startup neither provisions tables nor imports the old pg-boss queue.
	var queue *jobs.Queue
	var migrated bool
	if e = pool.QueryRow(ctx, "SELECT to_regclass('galaxy_go_jobs.control_v1') IS NOT NULL").Scan(&migrated); e != nil {
		return e
	}
	if migrated {
		var enabled bool
		if e = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')", endpoint).Scan(&enabled); e != nil {
			return e
		}
		if enabled {
			queue, e = jobs.New(pool, nil)
			if e != nil {
				return e
			}
		}
	}
	if queue != nil {
		legacySearch.Index.Jobs = queue
		informationWatches.Tasks = func(ctx context.Context, tx pgx.Tx, key string, payload information.Object, start time.Time) error {
			return queue.EnqueueInformationWatchWithin(ctx, tx, endpoint, payload, key, start)
		}
		informationWatches.HasOutstanding = func(ctx context.Context, tx pgx.Tx, watchID string, revision, checkRevision int64) (bool, error) {
			return queue.HasInformationWatchOutstandingWithin(ctx, tx, endpoint, watchID, revision, checkRevision)
		}
		evidenceService.Tasks = func(ctx context.Context, tx pgx.Tx, operationID, evidenceID, kind string) error {
			var available time.Time
			if err := tx.QueryRow(ctx, "SELECT available_at FROM jobs WHERE id=$1 AND kind=$2", operationID, kind).Scan(&available); err != nil {
				return err
			}
			_, err := queue.EnqueueWithin(ctx, tx, jobs.Task{ID: operationID, Endpoint: endpoint, Action: kind, SourceID: evidenceID, OperationID: operationID}, available)
			return err
		}
		ci.Tasks = evidenceService.Tasks
	}
	messageConfiguration, e := messagingconfig.Load(endpoint, os.Getenv("GALAXY_OPERATIONS_CONFIG_FILE"), os.Getenv("GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE"))
	if e != nil {
		return e
	}
	messages, mail := messageConfiguration.Services(pool, gateway, gateway.StoredOperators())
	if queue != nil {
		messages.Jobs = queue
		messages.Scheduler = &jobs.ScheduleQueue{Pool: pool, Queue: queue, Endpoint: endpoint}
	}
	messageHandler := messaging.Handler{Service: messages, SMTP: mail, Authority: gateway, Accounts: accountIdentity, Next: filegovernance.Handler{Service: fileGovernance, Next: accountHandler}}
	publicationCommands := &publication.Commands{Pool: pool, Endpoint: endpoint, Queue: queue}
	publicationHandler := publication.Handler{Commands: publicationCommands, Identity: gateway, Next: messageHandler}
	credentialHandler := credentials.Handler{Service: externalCredentials, Pool: pool, Identity: accountIdentity, Next: publicationHandler}
	privateHandler, e := privateDataHandler(pool, endpoint, devices, links, accountService, accountIdentity, budget, credentialHandler)
	if e != nil {
		return e
	}
	var loginProviders []accountlinks.LoginProvider
	identityHandler, e := identityLinksHandler(ctx, links, budgetPolicy, privateHandler, func(providers []accountlinks.LoginProvider) { loginProviders = providers })
	if e != nil {
		return e
	}
	trust := trustService(caseService, records, configurations, chatService, tasks, outcome, ci, budget)
	identityHandler = trustpackages.Handler{Service: trust, Next: identityHandler}
	personalAudit, e := personalAuditService(pool, endpoint, devices, governanceConfiguration)
	if e != nil {
		return e
	}
	identityHandler = personalaudit.Handler{Service: personalAudit, Next: identityHandler}
	exportService := subjectLifecycleService(pool, endpoint, devices, budgetPolicy, lifecycle, forum, tasks, outcome, projectService, contactService,
		subjectLifecycleSources{Cases: caseService, Records: records, Context: contextMaterials, Proofs: proofs, Capsules: capsuleSource, Builders: buildersService, Moderation: moderationService, Recruitment: recruitmentService, Choices: choiceService, Summaries: personalSummaries})
	personalServices := personalmcp.Services{
		Devices: devices, Summaries: personalSummaries, Choices: choiceService, Trust: trust, Tasks: tasks, Outcome: outcome,
		Contributions: contributionService, Honor: honors, RequesterHistory: requesterHistory, PublicWrites: tasks.Writes,
		Qualification: qualifications, Experience: experience, Comments: taskComments, CommentGovernance: commentGovernance,
		Cases: caseService, Records: records, Configurations: configurations, Context: contextMaterials,
		History: legacyHistory, HistoryV2: historyCurrent, CI: ci, Search: search, Profiles: identityProfiles, Exports: exportService,
		Chat: chatService, SharedSummaries: sharedSummaries, Attachments: chatFiles, Contacts: contactService,
		Forum: forum, Projects: projectService, Recruitment: recruitmentService, Opportunities: contactDiscovery,
		TargetGovernance: targetGovernance, Moderation: moderationService, Capsules: capsuleSource, Builders: buildersService,
		Hubs: hubsService, Peering: hubPeering, Information: informationService, InformationWatches: informationWatches,
		Inbox: inbox, Evidence: evidenceService, Proofs: proofs, LegacySearch: legacySearch, Audit: personalAudit,
	}
	personal, e := loadPersonalMCP(ctx, personalServices, loginProviders)
	if e != nil {
		return e
	}
	var personalConfigurationHash *string
	if personal != nil {
		hash := personal.ConfigurationHash()
		personalConfigurationHash = &hash
		personal.Next = identityHandler
		identityHandler = personal
	}
	if e = recordAPIConfiguration(ctx, gateway, devices, metadata, governanceConfiguration, startupForumPolicy, chatService, incidentState, lifecycle, budgetPolicy, identityConfigurationHash, chatConfigurationHash, requestQuotaHash, browserPolicyHash, personalConfigurationHash, release); e != nil {
		return e
	}
	if e = qualifications.UseRegistry(ctx); e != nil {
		return e
	}
	if e = experience.UseRegistry(ctx); e != nil {
		return e
	}
	if e = honors.UseRegistry(ctx); e != nil {
		return e
	}
	host := os.Getenv("GALAXY_LISTEN_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	if host != "127.0.0.1" && host != "0.0.0.0" {
		return fault.New("listen_configuration_invalid", 400)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1024 || n > 65535 {
		return fault.New("listen_configuration_invalid", 400)
	}
	listener, e := net.Listen("tcp", net.JoinHostPort(host, port))
	if e != nil {
		return fault.New("listen_unavailable", 503)
	}
	defer listener.Close()
	ownerData := subjectlifecycle.Handler{Service: exportService, Next: identityHandler}
	agentConfiguration, e := agentos.LoadConfiguration(os.Getenv("GALAXY_AGENTOS_CONFIG_FILE"), endpoint)
	if e != nil {
		return e
	}
	agentClient, e := agentos.New(agentConfiguration, agentos.Options{})
	if e != nil {
		return e
	}
	permissionService := &operationspermissions.Service{Pool: pool, Endpoint: endpoint, Authority: gateway,
		StoredAuthority: gateway.StoredOperators(),
		AIWork:          &operationsai.Service{Endpoint: endpoint}, RuntimeStatus: func(ctx context.Context) (operationspermissions.Object, error) { return agentClient.Status(ctx), nil }}
	agentStatus := agentos.StatusHandler{Client: agentClient, Authority: gateway, Next: servicemetadata.Handler{Service: metadata, Next: deviceauth.Handler{Service: devices, Next: feedback.Handler{Service: service, Identity: gateway, Next: ownerData}}}}
	agentConversations := &agentos.Conversations{Pool: pool, Endpoint: endpoint, Permissions: permissionService, Client: agentClient}
	autonomy := &operationsautonomy.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, AIWork: permissionService.AIWork}
	connectWorkbench(agentConversations, autonomy, logger)
	queries := &operationsqueries.Service{Pool: pool, Permissions: permissionService, Messaging: messages}
	agentConversations.ValidateSources = agentConversations.SourceValidator(queries.Revalidate)
	operationsDomain := &businessadmin.Domain{Pool: pool, Endpoint: endpoint, Authority: &operationspermissions.BusinessAuthority{Human: gateway, Duty: autonomy}, Duty: autonomy, PrincipalWithin: gateway.LockOperationsPrincipalWithin}
	businessAudit := &operationsaudit.Service{Domain: operationsDomain}
	retention := &operationsretention.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators()}
	if queue != nil {
		retention.EnqueueWithin = func(ctx context.Context, tx pgx.Tx, runID string) (string, error) {
			return queue.EnqueueRetentionWithin(ctx, tx, endpoint, runID)
		}
	}
	legacySearch.Index.Jobs = queue
	jobOperations := operationsJobService(gateway, autonomy, queue, legacySearch.Index, informationWatches, retention, messages, publicationCommands)
	queries.Jobs = jobOperations
	defer businessAudit.Close()
	workbench := &operationsqueries.Workbench{Domain: operationsDomain, Forum: forum, QueueSummary: queue.SummaryWithin, AutonomySummary: autonomy.WorkbenchSummaryWithAuthority}
	queries.Audit, queries.Workbench = businessAudit, workbench
	connectWorkbenchSummary(agentConversations, autonomy, queries)
	agentConversations.Tools.Query = queries.Query
	autonomy.QueryTool = queries.Query
	permissionService.Duty = autonomy
	forumOperations := &operationscommunity.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Duty: autonomy, PrincipalWithin: gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: gateway.ReadOperationsPrincipalWithin, Forum: forum, Files: forumFiles, Links: links}
	var executionDiscovery *discovery.Runtime
	executionGateway, strategies := connectExecutions(gateway, permissionService, autonomy, forumOperations, fileGovernance, agentClient, func() *discovery.Runtime { return executionDiscovery })
	agentConversations.Tools.AuthorizedWork = (&actions.AuthorizedWork{Gateway: executionGateway}).Execute
	forumPolicy, _ := forum.PolicySnapshot()
	resourceOperations := &operationsresources.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Duty: autonomy, PrincipalWithin: gateway.LockOperationsPrincipalWithin, Projects: projectService, Capsules: capsuleSource, MaxHideSeconds: policySeconds(forumPolicy["maxGovernanceHideSeconds"])}
	resourceOperations.MaxHideSecondsNow = func() int64 {
		current, _ := forum.PolicySnapshot()
		return policySeconds(current["maxGovernanceHideSeconds"])
	}
	autonomy.Permissions = permissionService
	autonomy.Native = &operationsautonomy.NativeClient{Client: agentClient}
	autonomy.RuntimeStatus = func(ctx context.Context) (operationsautonomy.Object, error) { return agentClient.Status(ctx), nil }
	autonomy.PersistedSourceWithin = messages.PersistedSourceWithin
	if queue != nil {
		autonomy.EnqueueWithin = func(ctx context.Context, tx pgx.Tx, kind string, payload operationsautonomy.Object, key string, start *time.Time) error {
			return queue.EnqueueAutonomyWithin(ctx, tx, endpoint, kind, payload, key, start)
		}
	}
	chatReports := chatReportService(gateway, operationsDomain, chatService, chatFiles)
	accountGovernance := businessAccountsService(operationsDomain, accountService, messageConfiguration.Directory)
	feedbackOperations := &feedback.Operations{Service: service, Domain: operationsDomain}
	queries.Feedback = feedbackOperations
	accountAnalytics := &operationsanalytics.Service{Domain: operationsDomain, AccountWithin: accountGovernance.AccountWithin, PublicActivityWithin: workbench.PublicActivityWithin}
	accountGovernance.DirectorySummary, accountGovernance.AccountSummary = accountAnalytics.DirectorySummary, accountAnalytics.AccountSummary
	accountGovernance.AnalysisQueryRead = accountAnalytics.QueryRead
	queries.Accounts = accountGovernance
	queries.Community, queries.Resources, queries.Files, queries.ChatReports = forumOperations, resourceOperations, fileGovernance, chatReports
	queries.Strategies, queries.Rules = strategies, policyRuntime.Service
	workbench.FileSummaryWithin = fileGovernance.ProcessingSummaryWithin
	businessActions := connectWorkbenchActions(agentConversations, autonomy, forumOperations, fileGovernance)
	businessActions.Resources, businessActions.ChatReports = resourceOperations, chatReports
	businessActions.AccountGovernance = accountGovernance
	businessActions.Messaging = messages
	businessActions.Feedback = feedbackOperations
	businessActions.Jobs = jobOperations
	businessActions.Strategies, businessActions.Rules = strategies, policyRuntime.Service
	permissionService.AIWork.HandlerReady = businessActions.ActionReady
	strategies.ActionReady = func(code, mode string) bool {
		if mode == "code" && code != "content.restore" && code != "files.scan.retry" {
			return false
		}
		return businessActions.ActionReady(code)
	}
	agentNative := agentos.NativeHandler{Conversations: agentConversations, Gateway: executionGateway, Client: agentClient, Next: agentStatus}
	conversationHTTP := agentos.ConversationHandler{Service: agentConversations, Authority: gateway, Next: agentNative}
	registeredHTTP, e := registeredUsersHandler(gateway, accountService, conversationHTTP, func(service *registeredusers.Service) { queries.RegisteredUsers = service })
	if e != nil {
		return e
	}
	managementHTTP, e := managementHandler(gateway, permissionService, operationsautonomy.Handler{Service: autonomy, Next: operationsautonomy.PrivateHandler{Service: autonomy, VerifyService: agentNative.VerifyService, Next: registeredHTTP}})
	if e != nil {
		return e
	}
	business := operationspermissions.Handler{Service: permissionService, Next: operationspermissions.AIWorkHandler{Service: permissionService, Next: operationscommunity.Handler{Service: forumOperations, Next: managementHTTP}}}
	var executionHTTP http.Handler = agentos.ExecutionHandler{Runtime: &agentos.ExecutionRuntime{Authority: executionGateway.Authority, Client: agentClient}, Authority: gateway, Next: business}
	executionHTTP = operationsstrategies.Handler{Service: strategies, VerifyService: agentNative.VerifyService, Next: executionHTTP}
	executionHTTP = operationsresources.Handler{Service: resourceOperations, Next: executionHTTP}
	executionHTTP = operationsrules.Handler{Service: policyRuntime.Service, Next: executionHTTP}
	executionHTTP = operationsretention.Handler{Service: retention, Next: executionHTTP}
	executionHTTP = chat.ReportHandler{Service: chatReports, Identity: chatIdentity{gateway}, Next: executionHTTP}
	executionHTTP = operationsaccounts.Handler{Service: accountGovernance, Authority: gateway, Next: executionHTTP}
	executionHTTP = operationsjobs.Handler{Service: jobOperations, Next: executionHTTP}
	forum.OperationsHandling = true
	workbenchHTTP := operationsqueries.WorkbenchHandler{Workbench: workbench, Authority: gateway, Next: executionHTTP}
	runOverview := &agentos.RunOverview{Pool: pool, Endpoint: endpoint, Human: gateway, Client: agentClient, ProjectWorkflow: operationsstrategies.ProjectNativeRun}
	queries.Runs = runOverview
	runReadHTTP := agentos.RunReadHandler{Service: runOverview, Next: workbenchHTTP}
	businessHTTPWithAudit := operationsaudit.Handler{Service: businessAudit, Authority: gateway, Next: runReadHTTP}
	businessHTTP, discoveryRuntime, discoveryConfiguration, e := discoveryHandler(ctx, gateway, forum, accountIdentity, autonomy, businessHTTPWithAudit)
	if e != nil {
		return e
	}
	actualConnections := discoveryconfig.ActualConnections(discoveryRuntime, discoveryConfiguration, agentClient, files)
	executionDiscovery = discoveryRuntime
	accountAnalytics.Runtime = discoveryRuntime
	if discoveryRuntime != nil {
		queries.Analytics, queries.Recommendations, queries.Search = discoveryRuntime, discoveryRuntime.Recommendations, discoveryRuntime.SearchQuality
		businessActions.SearchQuality, businessActions.Recommendations = discoveryRuntime.SearchQuality, discoveryRuntime.Recommendations
	}
	for _, result := range []systemsettings.Object{
		systemsettings.ReportServiceConnectionAdoption(ctx, os.Getenv("GALAXY_SERVICE_CONNECTIONS_METADATA_FILE"), "api", actualConnections, systemsettings.AdoptionOptions{}),
		systemsettings.ReportOperationsMailAdoption(ctx, os.Getenv("GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE"), "api", mail, os.Getenv("GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE"), systemsettings.AdoptionOptions{}),
	} {
		if result["state"] == "unavailable" {
			logger.Warn("system_settings_adoption_unconfirmed", "stage", "startup-adoption")
		}
	}
	businessHTTP, settingsNative, e := systemSettingsHandler(gateway, mail, publicationCommands, businessHTTP, func(service *systemsettings.Service, general *systemsettings.General) {
		queries.SystemSettings, queries.SystemGeneral = service, general
	})
	if e != nil {
		return e
	}
	businessHTTP, maintenanceService, maintenanceNative, e := maintenanceHandler(gateway, autonomy, queue, chatService, incidentState, settingsNative.Client, businessHTTP)
	if e != nil {
		return e
	}
	queries.Maintenance = maintenanceService
	businessHTTP, modelsNative, e := modelSettingsHandler(gateway, maintenanceNative.Client, businessHTTP)
	if e != nil {
		return e
	}
	documentation, e := documentationHandler(endpoint, businessHTTP)
	if e != nil {
		return e
	}
	var audit *failureaudit.Spool
	if directory := os.Getenv("GALAXY_TRUST_DIRECTORY"); directory != "" {
		audit, e = failureaudit.NewSpool(failureaudit.SpoolOptions{
			Path: filepath.Join(directory, "http-failure-audit.sqlite"), Endpoint: endpoint,
			Write: failureaudit.NewPostgresWriter(pool, endpoint),
			Logger: func(d failureaudit.Diagnostic) {
				logger.Info(d.Event, "stage", d.Stage, "code", d.Code, "delivery", d.Delivery)
			},
		})
		if e != nil {
			return e
		}
		defer audit.Close()
	}
	ready := boundedReadiness(ctx, 2*time.Second, func(ctx context.Context) bool {
		return audit != nil && audit.Status().Ready && deviceReady(devices, time.Now()) && pool.Ping(ctx) == nil
	})
	verifyPrivate := func(r *http.Request) error {
		switch r.URL.EscapedPath() {
		case "/v1/internal/models/authorize":
			_, err := modelsNative.VerifyService(r)
			return err
		case "/v1/internal/maintenance/authorize", "/v1/internal/maintenance/chat-probe":
			_, err := maintenanceNative.VerifyService(r)
			return err
		case "/v1/internal/system-settings/authorize", "/v1/internal/system-settings/mail":
			_, err := settingsNative.VerifyService(r)
			return err
		}
		return agentNative.VerifyService(r)
	}
	handler, e := httpBoundary(gateway, lifecycleHandler(lifecycle, incidentState, ready, events, gateway.SessionHandler(documentation)), verifyPrivate, boundaryConfiguration)
	if e != nil {
		return e
	}
	observer := failureaudit.HTTPObserver{
		Logger: func(d failureaudit.HTTPDiagnostic) {
			logger.Info(d.Event, "requestId", d.RequestID, "status", d.Status, "route", d.Route, "auditStatus", d.AuditStatus, "durationMs", d.DurationMS)
		},
		BeginHTTP: func() func(failureaudit.HTTPCompletion) {
			complete := metrics.BeginHTTP()
			return func(c failureaudit.HTTPCompletion) {
				complete(operationalmetrics.HTTPResult{Method: c.Method, Path: c.Path, Status: c.Status, BodyBytes: float64(c.BodyBytes), ReceivedBodyBytes: float64(c.ReceivedBodyBytes)})
			}
		},
	}
	if audit != nil {
		observer.Record = audit.Record
	}
	if release != nil {
		next := handler
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Galaxy-Release", release.ReleaseID)
			next.ServeHTTP(w, r)
		})
	}
	server := &http.Server{Handler: observer.Middleware(handler), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	metricListener, e := operationalmetrics.StartListener(metrics, metricConfig.Port)
	if e != nil {
		return e
	}
	defer metricListener.Close()
	// This entry composes migrated domains. Queue consumers and models have
	// independent owners; API startup neither migrates nor activates them.
	logger.Info("listening", "port", n)
	logger.Info("runtime_started", "stage", "listen")
	started = true
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	if len(credentialConfig.Issuers) > 0 {
		stopCredentials := startMaintenance(ctx, time.Minute, func(ctx context.Context) error {
			_, err := externalCredentials.RefreshDue(ctx, pool, 32)
			return err
		}, func(err error) {
			logger.Error("external_credentials_status_unavailable", "stage", "credentials-refresh", "error", err)
		})
		defer stopCredentials()
	}
	select {
	case e = <-done:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case <-ctx.Done():
		logger.Info("runtime_stopping", "stage", "shutdown")
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		e := server.Shutdown(shutdown)
		if e != nil {
			_ = server.Close()
		}
		return e
	}
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx); e != nil {
		slog.Error("Go API stopped", "code", fault.Code(e))
		os.Exit(1)
	}
}
