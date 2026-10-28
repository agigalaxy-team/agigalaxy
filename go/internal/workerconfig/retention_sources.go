package workerconfig

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/hubs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identitygroups"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/targetgovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/watchcontrol"
	"github.com/jackc/pgx/v5"
)

// productRetentionConsumers binds only the original owning cleanup consumers.
// It creates no identity, background plan or timer and does not dispatch an
// object DELETE from the uncommitted lifecycle transaction.
func (r *Runtime) productRetentionConsumers(at int64) (subjectlifecycle.RetentionConsumers, *taskmaterials.OutcomeService) {
	now := func() time.Time { return time.Unix(at, 0) }
	forum := r.Forum
	if forum == nil {
		forum = &community.Service{Pool: r.Pool, Endpoint: r.configuration.Endpoint, Policy: r.configuration.ForumPolicy}
	}
	// Keep the configured/adopted policy holder; freeze only this pass's clock.
	currentForum := *forum
	currentForum.Now = now
	tasks := &taskmaterials.Service{Pool: r.Pool, Endpoint: r.configuration.Endpoint, Now: now, Forum: taskmaterials.ForumSourceAdapter(currentForum.TaskMaterialSourceWithin)}
	outcome := &taskmaterials.OutcomeService{Service: tasks}
	if r.configuration.Files != nil {
		outcome.Store = r.configuration.Files.Store
	}
	controls := &watchcontrol.Service{Pool: r.Pool, Now: now}
	watches := &information.Watches{Pool: r.Pool, Now: now}
	targets := &targetgovernance.Service{Pool: r.Pool, Endpoint: r.configuration.Endpoint, Now: now}
	requests := &qualification.Service{Pool: r.Pool, Endpoint: r.configuration.Endpoint, Now: now}
	return subjectlifecycle.RetentionConsumers{
		PrivateConversations: accountarchive.CleanupRetentionWithin,
		TaskMaterials:        tasks.CleanupWithin,
		Forum:                forum.CleanupRetentionWithin,
		WatchControls: func(ctx context.Context, tx pgx.Tx, _ int64) (map[string]any, error) {
			return controls.PurgeExpiredWithin(ctx, tx)
		},
		IdentityGroups:   identitygroups.CleanupWithin,
		TargetGovernance: targets.CleanupRetentionWithin,
		InformationWatches: func(ctx context.Context, tx pgx.Tx, _ int64) (map[string]any, error) {
			return watches.PurgeExpiredWithin(ctx, tx)
		},
		Hubs: func(ctx context.Context, tx pgx.Tx, at int64) (map[string]any, error) {
			return hubs.CleanupRetentionWithin(ctx, tx, at, func(ctx context.Context, tx pgx.Tx, e hubs.ContentErasure) error {
				return subjectlifecycle.RecordContentErasureWithin(ctx, tx, subjectlifecycle.ContentErasure{Table: e.Table, Key: e.Key, SubjectID: e.SubjectID, OriginalHash: &e.OriginalHash, Reason: e.Reason, At: e.At, RetainedUntil: e.RetainedUntil})
			})
		},
		TaskComments:          tasks.CleanupCommentsWithin,
		QualificationRequests: requests.CleanupRequestsWithin,
		OutcomeMaterials: func(ctx context.Context, tx pgx.Tx, at int64) (map[string]any, error) {
			return outcome.CleanupWithin(ctx, tx, at, 100)
		},
		TaskSnapshots: subjectlifecycle.TaskRedactors{Task: taskmaterials.RedactTaskSnapshot, Participation: taskmaterials.RedactParticipationSnapshot},
	}, outcome
}
