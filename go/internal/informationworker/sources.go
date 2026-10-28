package informationworker

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/credentials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/experiencereviews"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/history"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/honor"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SourceConfiguration contains only the original files needed by current source
// readers. Account/admin sessions, directory credentials and signing keys are
// deliberately absent. Providers are public issuer/client metadata only.
type SourceConfiguration struct {
	Endpoint, RootPinsFile, KeyringFile, TrustDirectory                          string
	RetirementFile, IncidentFile, BudgetFile                                     string
	ForumPolicyFile, CommunityPolicyFile                                         string
	GovernanceFile, GovernanceReviewFile, GovernanceAuthoritiesFile, Environment string
	ExternalCredentialsFile, AttachmentsFile, CredentialsDirectory, ChatFile     string
	Providers                                                                    []accountlinks.Provider
	Now                                                                          func() time.Time
	Logger                                                                       *slog.Logger
}
type Sources struct {
	Watches     *information.Watches
	Information *information.Service
	Devices     *deviceauth.Service
	Budget      *resourcebudget.Service
	Retirement  *retirement.Controller
	Incident    *incident.Controller
	Policies    *operationsrules.Lifecycle
	Inbox       *notifications.Service
	closeChat   func() error
}

func (s *Sources) Close() error {
	if s.Policies != nil {
		s.Policies.Stop()
	}
	if s.closeChat != nil {
		return s.closeChat()
	}
	return nil
}

func sourceWrite(budget *resourcebudget.Service, scope string) cases.ResourceWrite {
	return func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, control bool, authorize func() error, operation func() (cases.Object, error)) (cases.Object, error) {
		if e := deviceauth.CheckInformationWatchWrite(a, scope); e != nil {
			return nil, e
		}
		value, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, func(context.Context, pgx.Tx) error { return authorize() }, func(context.Context, pgx.Tx) (any, error) { return operation() }, resourcebudget.Options{Control: control})
		if e != nil || value == nil {
			return nil, e
		}
		result, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("internal_error", 503)
		}
		return result, nil
	}
}
func governanceObjects(g community.GovernanceRuntime, key string, optional bool) ([]map[string]any, error) {
	raw, exists := g.Configuration[key]
	if !exists && optional {
		return []map[string]any{}, nil
	}
	values, ok := raw.([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	out := []map[string]any{}
	for _, value := range values {
		o, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		out = append(out, o)
	}
	return out, nil
}
func governanceStrings(g community.GovernanceRuntime, key string) ([]string, error) {
	values, ok := g.Configuration[key].([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	out := []string{}
	for _, value := range values {
		s, ok := value.(string)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		out = append(out, s)
	}
	return out, nil
}

// NewSources is wiring only: each source keeps its own original current reader,
// consent, reduction, signature verification and field order. No domain SQL or
// bearer/session fabrication is implemented in this process factory.
func NewSources(ctx context.Context, pool *pgxpool.Pool, c SourceConfiguration) (result *Sources, err error) {
	logger := c.Logger
	if logger == nil {
		logger = slog.Default()
	}
	devices, e := deviceauth.LoadReadOnly(ctx, pool, deviceauth.Configuration{Endpoint: c.Endpoint, RootPinsFile: c.RootPinsFile, KeyringFile: c.KeyringFile, TrustDirectory: c.TrustDirectory, Now: c.Now})
	if e != nil {
		return nil, e
	}
	retired, e := retirement.Load(c.RetirementFile, retirement.Options{Endpoint: c.Endpoint, Now: c.Now})
	if e != nil {
		return nil, e
	}
	retired.BindDevice(devices)
	incidents, e := incident.Load(c.IncidentFile, incident.Options{Endpoint: c.Endpoint, Now: c.Now})
	if e != nil {
		return nil, e
	}
	incidents.BindDevice(devices)
	policy, e := resourcebudget.Load(c.BudgetFile)
	if e != nil {
		return nil, e
	}
	budget, e := resourcebudget.New(policy, c.Now)
	if e != nil {
		return nil, e
	}
	s := &Sources{Devices: devices, Budget: budget, Retirement: retired, Incident: incidents}
	defer func() {
		if err != nil {
			_ = s.Close()
		}
	}()
	links := &accountlinks.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Accounts: &accounts.Service{Endpoint: c.Endpoint}, Providers: c.Providers}
	forumPolicy, e := community.LoadForumPolicy(c.ForumPolicyFile)
	if e != nil {
		return nil, e
	}
	quota, e := community.LoadCommunityPolicy(c.CommunityPolicyFile)
	if e != nil {
		return nil, e
	}
	promotion, e := community.CommunityPromotionDays(quota)
	if e != nil {
		return nil, e
	}
	governance, e := community.LoadGovernanceForRuntime(community.GovernanceOptions{ConfigurationPath: c.GovernanceFile, ReviewPath: c.GovernanceReviewFile, AuthoritiesPath: c.GovernanceAuthoritiesFile, Environment: c.Environment, Endpoint: c.Endpoint})
	if e != nil {
		return nil, e
	}
	moderators, e := governanceStrings(governance, "moderatorIds")
	if e != nil {
		return nil, e
	}
	credentialConfiguration, e := credentials.LoadConfiguration(c.ExternalCredentialsFile)
	if e != nil {
		return nil, e
	}
	external, e := credentials.New(c.Endpoint, credentialConfiguration, c.Now, nil, nil)
	if e != nil {
		return nil, e
	}
	forum := &community.Service{Pool: pool, Endpoint: c.Endpoint, DeviceAuth: devices, AccountLinks: links, Resources: budget, Policy: forumPolicy, PromotionDays: promotion, ModeratorIDs: moderators, Conditions: community.CredentialConditions{Service: external}, Now: c.Now}
	rooms := &chat.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Links: links, Resources: budget, Rules: &businessrules.Service{Endpoint: c.Endpoint, PromotionDays: promotion}, CommunityPolicy: quota, Now: c.Now}
	transport, _, e := chat.LoadTransport(c.ChatFile)
	if e != nil {
		return nil, e
	}
	if transport != nil {
		rooms.Transport = transport
		s.closeChat = transport.Stop
		startup, cancel := context.WithTimeout(ctx, 5*time.Second)
		e = transport.Start(startup)
		cancel()
		if e != nil {
			_ = transport.Stop()
			logger.Warn("chat_transport_unavailable", "code", fault.Code(e))
		}
	}
	storage, e := attachments.LoadConfiguration(c.AttachmentsFile, c.CredentialsDirectory)
	if e != nil {
		return nil, e
	}
	files := &chat.AttachmentService{Chat: rooms}
	if storage != nil {
		files.Store, files.Scanner, files.Policy = storage.Store, storage.Scanner, storage.Policy
	}
	rooms.Attachments = files
	writes := &publicwrites.Service{Pool: pool, Endpoint: c.Endpoint, Links: links, Policy: quota}
	cs := &cases.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Now: c.Now, ResourceWrite: sourceWrite(budget, "assistance")}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Resources: budget, Writes: writes, Links: links, Forum: taskmaterials.ForumSourceAdapter(forum.TaskMaterialSourceWithin), OwnedCaseLive: cs.RequireOwnedCaseLiveWithin, CaseOwnerSource: cs.RequireOwnerSourceWithin, CaseWithin: cs.CaseWithin, Now: c.Now}
	cs.TaskRead = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (cases.Object, error) {
		return tasks.RequireTaskWithin(ctx, tx, &a, id, false)
	}
	cs.Participation = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, task, id string) (cases.Object, error) {
		return tasks.RequireParticipationWithin(ctx, tx, a, task, id, false)
	}
	outcome := &taskmaterials.OutcomeService{Service: tasks}
	if storage != nil {
		outcome.Store = storage.Store
	}
	es := &evidence.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Now: c.Now, ResourceBudgetPolicy: policy, BudgetPolicyNow: budget.SnapshotPolicy}
	es.ResourceWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, authorize func() error, operation func() (evidence.Object, error)) (evidence.Object, error) {
		return sourceWrite(budget, "evidence")(ctx, tx, a, false, authorize, operation)
	}
	proofs := &evidence.ProofService{Evidence: es, CaseContext: cs.ProofCaseContextWithin}
	verifier, ok := devices.Signer.(evidence.ProofSigner)
	if !ok {
		return nil, fault.New("ci_proof_verifier_unavailable", 503)
	}
	proofs.Signer = verifier
	records := &verificationrecords.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Cases: cs, Proofs: proofs, Now: c.Now, ResourceWrite: verificationrecords.ResourceWrite(cs.ResourceWrite)}
	ci := &civ2.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Records: records, Signer: verifier, Now: c.Now, ResourceWrite: civ2.ResourceWrite(cs.ResourceWrite), ResourceBudgetPolicy: policy, BudgetPolicyNow: budget.SnapshotPolicy}
	records.CIProofWithin = ci.ProofWithin
	configs := &configurations.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Now: c.Now, ResourceWrite: configurations.ResourceWrite(cs.ResourceWrite)}
	cs.ConfigurationCondition = configs.ConditionWithin
	cs.VerificationReference = func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref cases.Object, id string, scope int64) (cases.Object, error) {
		return records.RequireReferenceWithin(ctx, tx, a, ref, verificationrecords.ReferenceOptions{CaseID: id, ScopeVersion: &scope})
	}
	cs.Sources = func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref, info cases.Object) (cases.Object, error) {
		id, _ := info["caseId"].(string)
		visited, _ := info["visited"].(map[string]bool)
		switch ref["kind"] {
		case "evidence", "verification":
			return records.RequireReferenceWithin(ctx, tx, a, ref, verificationrecords.ReferenceOptions{CaseID: id, Visited: visited})
		case "configuration":
			return configs.RequireReferenceWithin(ctx, tx, a, ref)
		case "selected-message":
			if a == nil {
				return nil, fault.New("access_denied", 403)
			}
			message, revision := sourceString(ref["id"]), sourceInteger(ref["version"])
			body, e := rooms.ReadSelectedWithin(ctx, tx, chat.Actor{Device: a}, message, revision)
			if e != nil {
				return nil, e
			}
			_, e = rooms.RequireSelectedWithin(ctx, tx, chat.Actor{Device: a}, sourceString(body["roomId"]), message, revision)
			return body, e
		case "outcome-material":
			if a == nil {
				return nil, fault.New("access_denied", 403)
			}
			value, e := outcome.ReadWithin(ctx, tx, taskmaterials.Actor{Actor: *a}, sourceString(ref["id"]))
			if e != nil {
				return nil, e
			}
			if id != "" && value["caseId"] != id {
				return nil, fault.New("source_case_mismatch", 422)
			}
			value["type"], value["contentHash"], value["sourceState"] = "outcome-material", value["sha256"], value["state"]
			return value, nil
		default:
			return nil, fault.New("source_adapter_unavailable", 503)
		}
	}
	cap := &capsules.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Cases: cs, Records: records, Proofs: proofs, Configurations: configs, Materials: outcome.ReadCapsuleWithin, Now: c.Now, ResourceWrite: capsules.ResourceWrite(cs.ResourceWrite)}
	cap.Selected = func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref capsules.Object) (capsules.Object, error) {
		if a == nil {
			return nil, fault.New("access_denied", 403)
		}
		message := sourceString(ref["messageId"])
		revision := sourceInteger(ref["revision"])
		body, e := rooms.ReadSelectedWithin(ctx, tx, chat.Actor{Device: a}, message, revision)
		if e != nil {
			return nil, e
		}
		_, e = rooms.RequireSelectedWithin(ctx, tx, chat.Actor{Device: a}, sourceString(body["roomId"]), message, revision)
		return body, e
	}
	cs.CapsuleUses = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (cases.Object, error) {
		return cap.UsesWithin(ctx, tx, &a, capsules.Object{"caseId": id, "limit": int64(20)})
	}
	profile := &profiles.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Now: c.Now}
	historyCurrent := &historyv2.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Cases: cs, Records: records, Proofs: proofs, Profiles: profile, Tasks: tasks.ReadHistoryWireWithin, CapsuleUses: cap.HistoryWireWithin, Now: c.Now}
	inbox := &notifications.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Resources: budget, Now: c.Now, EvidenceBlocked: func() bool { return !incidents.CanProcessEvidence() }}
	policies, e := governanceObjects(governance, "qualificationPolicies", false)
	if e != nil {
		return nil, e
	}
	q, e := qualification.New(pool, c.Endpoint, devices, policies, c.Now)
	if e != nil {
		return nil, e
	}
	q.Assistance, q.Cases, q.Proofs, q.Resources, q.IsBlockedWithin = tasks, cs, proofs, budget, inbox.IsBlockedWithin
	if e = q.UseRegistry(ctx); e != nil {
		return nil, e
	}
	tasks.ValidateQualification, tasks.LegacyQualification, tasks.ValidateParticipationQualification = q.ValidatePolicyWithin, q.EvaluateLegacyTaskWithin, q.ValidateParticipationWithin
	reviewers, e := governanceObjects(governance, "experienceReviewers", true)
	if e != nil {
		return nil, e
	}
	experience, e := experiencereviews.New(pool, c.Endpoint, devices, reviewers, c.Now)
	if e != nil {
		return nil, e
	}
	experience.Links, experience.Resources = links, budget
	if e = experience.UseRegistry(ctx); e != nil {
		return nil, e
	}
	q.ReadExperienceReview, q.ReadExperienceCalculation = experience.QualificationReadWithin, experience.ReadCalculationWithin
	sharing := &contributions.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Resources: budget, Tasks: tasks, Now: c.Now}
	rules, e := governanceObjects(governance, "honorRules", false)
	if e != nil {
		return nil, e
	}
	honors, e := honor.New(pool, c.Endpoint, devices, rules, c.Now)
	if e != nil {
		return nil, e
	}
	honors.Assistance, honors.Proofs, honors.Qualification, honors.Sharing, honors.CI = tasks, proofs, q, sharing, ci
	if e = honors.UseRegistry(ctx); e != nil {
		return nil, e
	}
	assessors, e := governanceStrings(governance, "builderAssessorIds")
	if e != nil {
		return nil, e
	}
	pins, e := governanceObjects(governance, "conformanceSuitePins", false)
	if e != nil {
		return nil, e
	}
	builderSource := &builders.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Cases: cs, Configurations: configs, VerificationRecords: records, Proofs: proofs, AssessorIDs: assessors, SuitePins: pins, Now: c.Now, ResourceWrite: builders.ResourceWrite(cs.ResourceWrite)}
	moderator := &moderation.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Cases: cs, Assistance: tasks, Evidence: es, Resources: budget, ModeratorIDs: moderators, Now: c.Now}
	proofs.Moderation = moderator.CaseContextWithin
	oldHistory := &history.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Profiles: profile, Moderation: moderator.CaseContextWireWithin, CapsuleUses: cap.LegacyHistoryWireWithin, Now: c.Now}
	oldHistory.Proofs = func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (json.RawMessage, error) {
		return proofs.ReadWireWithin(ctx, tx, a, id, false)
	}
	index := &discovery.LegacyIndex{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Evidence: es}
	// This is an insert-only API-side producer, exactly like the API's legacy
	// search recovery source. It never starts a queue or claims worker work.
	producer, e := jobs.New(pool, nil)
	if e != nil {
		return nil, e
	}
	index.Jobs = producer
	legacy := &discovery.LegacySearch{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Proofs: proofs, HistoryQuery: oldHistory.QueryWire, CapsulesQuery: cap.QueryWire, Index: index}
	legacy.BuildersQuery = func(ctx context.Context, a *deviceauth.Actor, raw []byte, candidates []string) (json.RawMessage, error) {
		return builderSource.QueryWire(ctx, a, raw, builders.QueryOptions{PublicOnly: true, SourceSearch: true, CandidateIDs: candidates})
	}
	projectsSource := &projects.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Links: links, Profiles: profile, Resources: budget, Now: c.Now}
	opps := &opportunities.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Profiles: profile, History: historyCurrent, Notifications: inbox, Now: c.Now}
	opps.UseProjects(projectsSource)
	recruit := &recruitment.Service{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Projects: projectsSource, Opportunities: opps, Tasks: tasks, Inbox: inbox, PublicWrites: writes, Resources: budget, Now: c.Now}
	opps.Recruitment, opps.RecruitmentOpportunity = recruit, recruit.RequireContactOpportunityWithin
	search := &searchv2.Service{Pool: pool, Devices: devices, History: historyCurrent, CI: ci, Capsules: cap.QueryV2Wire, Legacy: legacy.QueryWire, Now: c.Now}
	search.Tasks = func(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		var input struct {
			View, Query string
			After       *string
			Limit       int
		}
		if e := protocol.Decode(raw, &input); e != nil {
			return nil, e
		}
		var viewer *taskmaterials.Actor
		if a != nil {
			viewer = &taskmaterials.Actor{Actor: *a}
		}
		after := ""
		if input.After != nil {
			after = *input.After
		}
		return tasks.QueryTasksWire(ctx, viewer, input.View, input.Query, after, input.Limit)
	}
	search.Opportunities = func(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		var input opportunities.Object
		if e := protocol.Decode(raw, &input); e != nil {
			return nil, e
		}
		return opps.QueryWire(ctx, a, input)
	}
	info := &information.Service{Endpoint: c.Endpoint, Search: search, Now: c.Now}
	info.Honor = func(ctx context.Context, a *deviceauth.Actor, raw []byte) (information.Object, error) {
		var input honor.Object
		if e := protocol.Decode(raw, &input); e != nil {
			return nil, e
		}
		var viewer *honor.Actor
		if a != nil {
			viewer = &honor.Actor{Actor: *a}
		}
		return honors.QueryV2(ctx, viewer, input)
	}
	watches := &information.Watches{Pool: pool, Devices: devices, Information: info, Now: c.Now, ResourceWrite: information.ResourceWrite(sourceWrite(budget, "notifications")), CanProcessEvidence: func() bool { return retired.CanProcessEvidence() && incidents.CanProcessEvidence() }}
	inbox.Readers.Information = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate notifications.Object) (notifications.Object, error) {
		return watches.NotificationWithin(ctx, tx, a, sourceString(candidate["event_id"]))
	}
	s.Information, s.Watches, s.Inbox = info, watches, inbox
	s.Policies, e = startSourcePolicies(ctx, pool, c, budget, forum, writes, logger)
	if e != nil {
		return nil, e
	}
	return s, nil
}
func sourceString(v any) string { s, _ := v.(string); return s }
func sourceInteger(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		v, _ := n.Int64()
		return v
	}
	return 0
}
