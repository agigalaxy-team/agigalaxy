package main

import (
	"context"
	"math"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/choices"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	contextdata "github.com/agigalaxy-team/agigalaxy/go/internal/context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/summaries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type subjectLifecycleSources struct {
	Cases       *cases.Service
	Records     *verificationrecords.Service
	Context     *contextdata.Service
	Proofs      *evidence.ProofService
	Capsules    *capsules.Service
	Builders    *builders.Service
	Moderation  *moderation.Service
	Recruitment *recruitment.Service
	Choices     *choices.Service
	Summaries   *summaries.Service
}

func subjectLifecycleHandler(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, policy *resourcebudget.Policy, retired *retirement.Controller, forum *community.Service, tasks *taskmaterials.Service, outcome *taskmaterials.OutcomeService, projectService *projects.Service, contacts *chat.ContactService, next http.Handler, extra ...subjectLifecycleSources) http.Handler {
	return subjectlifecycle.Handler{Service: subjectLifecycleService(pool, endpoint, devices, policy, retired, forum, tasks, outcome, projectService, contacts, extra...), Next: next}
}

func subjectLifecycleService(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, policy *resourcebudget.Policy, retired *retirement.Controller, forum *community.Service, tasks *taskmaterials.Service, outcome *taskmaterials.OutcomeService, projectService *projects.Service, contacts *chat.ContactService, extra ...subjectLifecycleSources) *subjectlifecycle.Service {
	service := &subjectlifecycle.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Budget: policy,
		AssertDownload: retired.AssertDownload, ServiceStatus: func() any { return retired.Snapshot() },
		DownloadDeadline: func() int64 {
			deadline := retired.DownloadDeadline()
			if math.IsInf(deadline, 1) {
				return math.MaxInt64
			}
			return int64(deadline)
		}}
	service.ConnectForum(subjectlifecycle.ForumConsumers{
		ReadVersion: func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, post, version string) (subjectlifecycle.Object, error) {
			return forum.ReadLifecycleVersionWithin(ctx, tx, actor.Actor, post, version)
		},
		ReadReply: func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, reply string) (subjectlifecycle.Object, error) {
			return forum.ReadLifecycleReplyWithin(ctx, tx, actor.Actor, reply)
		},
		PermissionAllowed: forum.LifecyclePermissionAllowedWithin,
	})
	service.Transforms["task-materials"] = func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, item subjectlifecycle.Object, _ int64) (subjectlifecycle.Object, error) {
		return tasks.ExportMaterialWithin(ctx, tx, actor.Actor, item)
	}
	service.Views["task"] = func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, view subjectlifecycle.View, _ string) (any, error) {
		return tasks.ReadTaskWithin(ctx, tx, &actor.Actor, view.ID)
	}
	service.Views["project"] = func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, view subjectlifecycle.View, _ string) (any, error) {
		return projectService.ReadWithin(ctx, tx, &actor.Actor, view.ID)
	}
	service.Views["contact"] = func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, view subjectlifecycle.View, _ string) (any, error) {
		return contacts.ReadContactWithin(ctx, tx, actor.Actor, view.ID)
	}
	service.OutcomeMaterials = func(ctx context.Context, tx pgx.Tx, actor subjectlifecycle.Actor, id string) (subjectlifecycle.Object, error) {
		return outcome.ReadWithin(ctx, tx, taskmaterials.Actor{Actor: actor.Actor}, id)
	}
	service.OwnerReaders = map[string]subjectlifecycle.OwnerReader{
		"profile-statements":          subjectlifecycle.ProfileStatements,
		"reading-bookmarks":           subjectlifecycle.ReadingBookmarks("reading-bookmarks"),
		"reading-bookmark-operations": subjectlifecycle.ReadingBookmarks("reading-bookmark-operations"),
	}
	// The remaining owner rows and temporary-text projections retain the original
	// lifecycle catalog/cutoff implementation. They are not replaced by composite
	// ExportOwned DTOs, which could add other authors' content to an owner dataset.
	if len(extra) > 0 {
		connectSubjectLifecycleViews(service, tasks, extra[0])
	}
	return service
}

func connectSubjectLifecycleViews(service *subjectlifecycle.Service, tasks *taskmaterials.Service, s subjectLifecycleSources) {
	if s.Choices != nil {
		service.Views["choice-snapshot"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Choices.GetLifecycleWithin(ctx, tx, a.Actor, v.ID)
		}
	}
	if s.Recruitment != nil {
		service.Views["recruitment"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Recruitment.ReadWithin(ctx, tx, &a.Actor, v.ID, false)
		}
	}
	if s.Summaries != nil {
		service.Views["personal-summary"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Summaries.GetLifecycleWithin(ctx, tx, a.Actor, v.ID)
		}
	}
	service.Views["assistance"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
		return tasks.LegacyReadWithin(ctx, tx, &a.Actor, v.ID)
	}
	if s.Cases != nil {
		service.Views["case"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			taskID := ""
			if v.TaskID != nil {
				taskID = *v.TaskID
			}
			return s.Cases.ReadV2Within(ctx, tx, a.Actor, v.ID, taskID)
		}
	}
	if s.Records != nil {
		for _, kind := range []string{"evidence", "verification"} {
			service.Views[kind] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
				ref := verificationrecords.Object{"type": v.Kind, "id": v.ID}
				if v.Version != nil {
					ref["version"] = *v.Version
				}
				return s.Records.ReadWithin(ctx, tx, &a.Actor, ref)
			}
		}
	}
	if s.Context != nil {
		service.ContextView = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, auth deviceauth.ControlAuthorization, kind string) (any, error) {
			requestID := ""
			if a.HTTPRequestID != nil {
				requestID = *a.HTTPRequestID
			}
			return s.Context.ReadV1Within(ctx, tx, a.Actor, v.ID, true, auth, kind, requestID)
		}
	}
	if s.Proofs != nil {
		service.Views["proof"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Proofs.ReadWithin(ctx, tx, &a.Actor, v.ID, false)
		}
	}
	if s.Capsules != nil {
		service.Views["capsule"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			ref := capsules.Object{"capsuleId": v.ID}
			if v.VersionID != nil {
				ref["versionId"] = *v.VersionID
			}
			return s.Capsules.ReadWithin(ctx, tx, &a.Actor, ref)
		}
	}
	if s.Builders != nil {
		service.Views["builder"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Builders.ReadWithin(ctx, tx, &a.Actor, builders.Object{"builderId": v.ID})
		}
		service.Views["builder-support"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Builders.SupportWithin(ctx, tx, &a.Actor, builders.Object{"builderId": v.ID})
		}
	}
	if s.Moderation != nil {
		service.Views["moderation"] = func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, v subjectlifecycle.View, _ string) (any, error) {
			return s.Moderation.ReadLifecycleWithin(ctx, tx, &a.Actor, v.ID)
		}
	}
}
