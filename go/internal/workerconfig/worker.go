// Package workerconfig assembles only explicitly adopted, migrated consumers.
// It never migrates schemas, provisions grants, imports pg-boss or changes gates.
package workerconfig

import (
	"context"
	"log/slog"
	"net/url"
	"os"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discoveryconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messagingconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsretention"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	RuntimeSources                                            *runtimeconfig.LoadedSources
	OperatorRef                                               string
	Forum                                                     *community.Service
	DatabaseURL, Endpoint                                     string
	Files                                                     *attachments.Configuration
	CanScan                                                   func(context.Context) (bool, error)
	Diagnostic                                                func(stage, id, code string)
	BudgetPolicy                                              *resourcebudget.Policy
	BudgetPolicyNow                                           func() *resourcebudget.Policy
	BudgetManager                                             *resourcebudget.Service
	SearchIndexMode                                           string
	OperationsFile                                            string
	Messaging                                                 *messagingconfig.Configuration
	AgentOS                                                   agentos.Configuration
	Discovery                                                 *discovery.Configuration
	ForumPolicy                                               community.Object
	RegisteredDirectory                                       *registeredusers.Native
	ServiceMetadataFile, MailMetadataFile, MailCredentialFile string
}

func Load(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	c := Config{DatabaseURL: getenv("DATABASE_URL"), Endpoint: getenv("GALAXY_ENDPOINT")}
	c.RuntimeSources = &runtimeconfig.LoadedSources{}
	c.OperatorRef = getenv("GALAXY_OPERATOR_REF")
	c.ServiceMetadataFile, c.MailMetadataFile, c.MailCredentialFile = getenv("GALAXY_SERVICE_CONNECTIONS_METADATA_FILE"), getenv("GALAXY_SYSTEM_SETTINGS_MAIL_METADATA_FILE"), getenv("GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE")
	if e := c.validate(); e != nil {
		return Config{}, e
	}
	var e error
	release, e := runtimeconfig.RuntimeServiceRelease(getenv, "worker", "")
	if e != nil {
		return Config{}, e
	}
	c.RuntimeSources.ObserveRelease(release)
	c.Files, e = attachments.LoadConfiguration(getenv("GALAXY_ATTACHMENTS_CONFIG_FILE"), getenv("CREDENTIALS_DIRECTORY"))
	if e != nil {
		return Config{}, e
	}
	c.CanScan, e = loadEvidenceGate(c.Endpoint, getenv("GALAXY_RETIREMENT_FILE"), getenv("GALAXY_INCIDENT_FILE"), time.Now, captureEvidenceSources(c.RuntimeSources))
	if e != nil {
		return Config{}, e
	}
	c.BudgetPolicy, e = resourcebudget.Load(getenv("GALAXY_RESOURCE_BUDGET_FILE"))
	if e != nil {
		return Config{}, e
	}
	c.SearchIndexMode = getenv("GALAXY_SEARCH_INDEX_ENABLED")
	if c.SearchIndexMode != "" && c.SearchIndexMode != "true" && c.SearchIndexMode != "false" {
		return Config{}, fault.New("invalid_search_index_state", 400)
	}
	c.OperationsFile = getenv("GALAXY_OPERATIONS_CONFIG_FILE")
	c.Messaging, e = messagingconfig.Load(c.Endpoint, c.OperationsFile, getenv("GALAXY_MESSAGING_SMTP_CREDENTIAL_FILE"))
	if e != nil {
		return Config{}, e
	}
	c.AgentOS, e = agentos.LoadConfiguration(getenv("GALAXY_AGENTOS_CONFIG_FILE"), c.Endpoint)
	if e != nil {
		return Config{}, e
	}
	c.Discovery, e = discovery.LoadConfiguration(getenv("GALAXY_DISCOVERY_CONFIG_FILE"), c.Endpoint)
	if e != nil {
		return Config{}, e
	}
	c.RegisteredDirectory, e = access.LoadRegisteredDirectory(getenv("GALAXY_REGISTERED_DIRECTORY_CONFIG_FILE"), false, "")
	if e != nil {
		return Config{}, e
	}
	if c.Discovery != nil {
		if c.Discovery.SourceMetadata == nil {
			return Config{}, fault.New("discovery_worker_source_metadata_required", 503)
		}
	}
	c.ForumPolicy, e = community.LoadForumPolicy(getenv("GALAXY_FORUM_POLICY_FILE"))
	if e != nil {
		return Config{}, e
	}
	return c, nil
}
func (c Config) validate() error {
	u, e := url.Parse(c.Endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || c.DatabaseURL == "" {
		return fault.New("worker_configuration_invalid", 400)
	}
	return nil
}

type Runtime struct {
	Retention              *operationsretention.Service
	Forum                  *community.Service
	PolicyRuntime          *operationsrules.Lifecycle
	Pool                   *pgxpool.Pool
	Queue                  *jobs.Queue
	Consumers              *feedback.WorkerConsumers
	Evidence               *evidence.Service
	CI                     *civ2.Service
	Messaging              *messaging.Service
	Scheduler              *jobs.ScheduleQueue
	Autonomy               *operationsautonomy.Worker
	nextAutonomyHealth     time.Time
	Discovery              *discovery.Worker
	LegacyIndex            *discovery.LegacyIndex
	Probes                 *builders.ProbeWorker
	discoverySeedComplete  bool
	nextDiscoveryReconcile time.Time
	Registered             *registeredusers.Directory
	nextRegisteredSync     time.Time
	nextRetentionCheck     time.Time
	configuration          Config
	attachmentMaintenance  func(context.Context)
}

// Open owns an independent process pool. A missing schema/gate cannot enable
// fallback consumption. An administrator must first stop old consumers and
// explicitly select River for the exact endpoint outside this runtime.
func Open(ctx context.Context, c Config) (*Runtime, error) {
	if e := c.validate(); e != nil {
		return nil, e
	}
	pool, e := postgres.Open(ctx, c.DatabaseURL)
	if e != nil {
		return nil, fault.New("database_unavailable", 503)
	}
	if e = postgres.AssertRecoveryReady(ctx, pool); e != nil {
		pool.Close()
		return nil, e
	}
	if e = recordWorkerConfiguration(ctx, pool, c); e != nil {
		pool.Close()
		return nil, e
	}
	r, e := assemble(ctx, pool, c)
	if e != nil {
		pool.Close()
		return nil, e
	}
	return r, nil
}
func assemble(ctx context.Context, pool *pgxpool.Pool, c Config) (*Runtime, error) {
	if c.Forum == nil {
		c.Forum = &community.Service{Pool: pool, Endpoint: c.Endpoint, Policy: c.ForumPolicy}
	}
	adoptForum, e := c.Forum.PolicyAdopter()
	if e != nil {
		return nil, e
	}
	if c.BudgetManager == nil {
		manager, err := resourcebudget.New(c.BudgetPolicy, nil)
		if err != nil {
			return nil, err
		}
		c.BudgetManager = manager
	}
	if c.BudgetPolicyNow == nil {
		c.BudgetPolicyNow = c.BudgetManager.SnapshotPolicy
	}
	var adopted bool
	if e := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')", c.Endpoint).Scan(&adopted); e != nil {
		return nil, fault.New("operations_jobs_schema_unavailable", 503)
	}
	if !adopted {
		return nil, fault.New("operations_jobs_not_adopted", 409)
	}
	var schemaReady bool
	if e := pool.QueryRow(ctx, "SELECT to_regclass('galaxy_river.river_job') IS NOT NULL AND to_regclass('galaxy_go_jobs.executions_v1') IS NOT NULL").Scan(&schemaReady); e != nil || !schemaReady {
		return nil, fault.New("operations_jobs_schema_unavailable", 503)
	}
	repo := &feedback.AttachmentRepository{Endpoint: c.Endpoint}
	if c.Files != nil {
		repo.Store = c.Files.Store
		repo.Scanner = c.Files.Scanner
		repo.Policy = c.Files.Policy
		repo.DraftRetentionDays = c.Files.DraftRetentionDays
		repo.SubmittedRetentionDays = c.Files.SubmittedRetentionDays
	}
	service := &feedback.Service{Pool: pool, Endpoint: c.Endpoint, Attachments: repo}
	consumers := &feedback.WorkerConsumers{Service: service, CanScan: func(ctx context.Context) (bool, error) {
		if c.Files == nil || c.CanScan == nil {
			return false, nil
		}
		return c.CanScan(ctx)
	}, Diagnostic: func(stage, id, code string) {
		if c.Diagnostic != nil {
			c.Diagnostic(stage, id, code)
			return
		}
		slog.Warn("feedback worker deferred", "stage", stage, "sourceId", id, "code", code)
	}}
	device := &deviceauth.Service{Pool: pool, Endpoint: c.Endpoint}
	evidenceService := &evidence.Service{Pool: pool, Endpoint: c.Endpoint, Devices: device, ResourceBudgetPolicy: c.BudgetPolicy, BudgetPolicyNow: c.BudgetPolicyNow, ConsentReader: device.RequireWorkerConsentWithin}
	evidenceService.LockCaseState = evidenceService.WorkerCaseStateWithin
	caseSource := &cases.Service{Pool: pool, Endpoint: c.Endpoint, Devices: device}
	records := &verificationrecords.Service{Pool: pool, Endpoint: c.Endpoint, Devices: device, Cases: caseSource}
	ciService := &civ2.Service{Pool: pool, Endpoint: c.Endpoint, Devices: device, Records: records, ResourceBudgetPolicy: c.BudgetPolicy, BudgetPolicyNow: c.BudgetPolicyNow, ConsentReader: device.RequireWorkerConsentWithin}
	ciService.SourceReader = ciService.WorkerSourceReader
	legacyIndex, e := legacyIndexWorker(ctx, pool, c, device, evidenceService)
	if e != nil {
		return nil, e
	}
	probes := &builders.ProbeWorker{Service: &builders.Service{Pool: pool, Endpoint: c.Endpoint, Devices: device}, Budget: c.BudgetPolicy, BudgetPolicyNow: c.BudgetPolicyNow}
	var messages *messaging.Service
	var smtp *messaging.SMTPService
	var stored *access.StoredOperatorAuthority
	if c.OperationsFile != "" {
		loaded, err := access.LoadWorker(ctx, pool, c.Endpoint, c.OperationsFile)
		if err != nil {
			return nil, err
		}
		stored = loaded
	}
	if c.Messaging != nil {
		var approver messaging.ApprovalAuthority
		if stored != nil {
			approver = stored
		}
		messages, smtp = c.Messaging.Services(pool, nil, approver)
		messages.PlanLockWithin = messaging.WorkerPlanLockWithin
	}
	autonomy, e := autonomyWorker(pool, c, stored, messages)
	if e != nil {
		return nil, e
	}
	retention := &operationsretention.Service{Pool: pool, Endpoint: c.Endpoint}
	if stored != nil {
		retention.StoredAuthority = stored
	}
	execute := func(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
		if task.Action == jobs.RetentionCleanup {
			return retention.Work(ctx, task)
		}
		if task.Action == jobs.SearchRecovery {
			if legacyIndex == nil {
				return jobs.Outcome{}, fault.New("operations_job_consumer_unavailable", 503)
			}
			return legacyIndex.Work(ctx, task)
		}
		if task.Action == jobs.AutonomyTask || task.Action == jobs.AutonomyTick {
			var out operationsautonomy.Object
			var err error
			if task.Action == jobs.AutonomyTask {
				out, err = autonomy.Execute(ctx, task.Payload)
			} else {
				out, err = autonomy.Tick(ctx)
			}
			return jobs.Outcome{Result: out}, err
		}
		if task.Action == jobs.AccountNotice || task.Action == jobs.MessagingRun || task.Action == jobs.MessagingDelivery {
			if messages == nil {
				return jobs.Outcome{}, fault.New("operations_job_consumer_unavailable", 503)
			}
			return messages.Work(ctx, task)
		}
		if task.Action != jobs.EvidenceVerifyGithub && task.Action != jobs.EvidenceVerifyGithubV2 {
			return consumers.Execute(ctx, task)
		}
		if c.CanScan == nil {
			return jobs.Outcome{Result: map[string]any{"processed": false, "paused": true}, RetryAt: time.Now().Add(time.Second)}, nil
		}
		allowed, err := c.CanScan(ctx)
		if err != nil {
			return jobs.Outcome{}, err
		}
		if !allowed {
			return jobs.Outcome{Result: map[string]any{"processed": false, "paused": true}, RetryAt: time.Now().Add(time.Second)}, nil
		}
		var outcome evidence.JobOutcome
		if task.Action == jobs.EvidenceVerifyGithubV2 {
			if _, err = ciService.RecoverExpired(ctx); err != nil {
				return jobs.Outcome{}, err
			}
			outcome, err = ciService.ProcessJob(ctx, task.ID, nil)
		} else {
			if _, err = evidenceService.RecoverExpired(ctx); err != nil {
				return jobs.Outcome{}, err
			}
			outcome, err = evidenceService.ProcessJob(ctx, task.ID, nil)
		}
		if err != nil {
			return jobs.Outcome{}, err
		}
		if outcome.RetryAt.IsZero() {
			var state string
			var available time.Time
			if err = pool.QueryRow(ctx, "SELECT state,CASE WHEN state='running' THEN locked_until ELSE available_at END FROM jobs WHERE id=$1 AND kind=$2", task.ID, task.Action).Scan(&state, &available); err != nil {
				return jobs.Outcome{}, err
			}
			if state == "pending" || state == "running" {
				outcome.RetryAt = available
				if !outcome.RetryAt.After(time.Now()) {
					outcome.RetryAt = time.Now().Add(time.Second)
				}
			}
		}
		return jobs.Outcome{Result: outcome.Result, RetryAt: outcome.RetryAt}, nil
	}
	queues := map[string]int{jobs.FeedbackScan: 1, jobs.FeedbackOwnerDeletion: 1, jobs.EvidenceVerifyGithub: 1, jobs.EvidenceVerifyGithubV2: 1}
	queues[jobs.AutonomyTask], queues[jobs.AutonomyTick] = 1, 1
	if stored != nil {
		queues[jobs.RetentionCleanup] = 1
	}
	if legacyIndex != nil {
		queues[jobs.SearchRecovery] = 1
	}
	if messages != nil {
		queues[jobs.AccountNotice], queues[jobs.MessagingRun], queues[jobs.MessagingDelivery] = 1, 1, 1
	}
	queue, e := jobs.NewWithQueues(pool, execute, queues)
	if e != nil {
		return nil, e
	}
	if messages != nil {
		messages.Jobs = queue
	}
	if legacyIndex != nil {
		legacyIndex.Jobs = queue
	}
	runtime := &Runtime{Pool: pool, Queue: queue, Consumers: consumers, Evidence: evidenceService, CI: ciService, Messaging: messages, Autonomy: autonomy, LegacyIndex: legacyIndex, Probes: probes, Forum: c.Forum, Retention: retention}
	runtime.adoptScheduler(queue, c, stored)
	runtime.adoptAutonomy(queue)
	runtime.adoptRegistered(c)
	runtime.Discovery, e = discoveryWorker(ctx, pool, c)
	if e != nil {
		return nil, e
	}
	var discoveryRuntime *discovery.Runtime
	if runtime.Discovery != nil {
		discoveryRuntime = runtime.Discovery.Runtime
	}
	actualConnections := discoveryconfig.ActualConnections(discoveryRuntime, c.Discovery, nil, c.Files)
	for _, result := range []systemsettings.Object{
		systemsettings.ReportServiceConnectionAdoption(ctx, c.ServiceMetadataFile, "worker", actualConnections, systemsettings.AdoptionOptions{}),
		systemsettings.ReportOperationsMailAdoption(ctx, c.MailMetadataFile, "worker", smtp, c.MailCredentialFile, systemsettings.AdoptionOptions{}),
	} {
		if result["state"] == "unavailable" && c.Diagnostic != nil {
			c.Diagnostic("startup-adoption", "", "system_settings_adoption_unconfirmed")
		}
	}
	runtime.PolicyRuntime, e = startWorkerPolicies(ctx, pool, c, adoptForum)
	if e != nil {
		return nil, e
	}
	return runtime, nil
}

// Run gives in-flight work its original River job timeout while Stop first
// stops claiming. The shutdown deadline bounds graceful draining.
func (r *Runtime) Run(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	work, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	if e := r.Queue.Start(work); e != nil {
		return e
	}
	r.autonomyMaintenance(ctx)
	r.registeredMaintenance(ctx)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	discoveryTick := time.NewTicker(time.Second)
	defer discoveryTick.Stop()
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-ticker.C:
			r.maintenance(ctx)
		case <-discoveryTick.C:
			r.sourceMaintenance(ctx)
			r.discoveryMaintenance(ctx)
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	e := r.Queue.Stop(shutdown)
	if e != nil {
		cancelWork()
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = r.Queue.Stop(cleanup)
	}
	return e
}
func (r *Runtime) Close() {
	if r.PolicyRuntime != nil {
		r.PolicyRuntime.Stop()
	}
	r.Pool.Close()
}
