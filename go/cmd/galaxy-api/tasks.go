package main

import (
	"context"
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func taskServices(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, links *accountlinks.Service, budget *resourcebudget.Service, forum *community.Service, rooms *chat.Service, files *chat.AttachmentService, storage *attachments.Configuration) (*taskmaterials.Service, *taskmaterials.OutcomeService, *cases.Service, error) {
	policy, e := community.LoadCommunityPolicy(os.Getenv("GALAXY_COMMUNITY_QUOTA_FILE"))
	if e != nil {
		return nil, nil, nil, e
	}
	writes := &publicwrites.Service{Pool: pool, Endpoint: endpoint, Links: links, Policy: policy}
	caseService := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices}
	caseService.ResourceWrite = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, control bool, authorize func() error, operation func() (cases.Object, error)) (cases.Object, error) {
		if err := deviceauth.CheckInformationWatchWrite(actor, "assistance"); err != nil {
			return nil, err
		}
		value, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: actor.SubjectID}, func(context.Context, pgx.Tx) error { return authorize() }, func(context.Context, pgx.Tx) (any, error) { return operation() }, resourcebudget.Options{Control: control})
		if e != nil {
			return nil, e
		}
		if value == nil {
			return nil, nil
		}
		result, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("internal_error", 503)
		}
		return result, nil
	}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Resources: budget, Writes: writes, Links: links,
		Forum: taskmaterials.ForumSourceAdapter(forum.TaskMaterialSourceWithin), OwnedCaseLive: caseService.RequireOwnedCaseLiveWithin, CaseWithin: caseService.CaseWithin}
	tasks.CaseOwnerSource = caseService.RequireOwnerSourceWithin
	tasks.ValidateDelivery = func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, input taskmaterials.DeliveryInput) error {
		_, err := caseService.ValidateDeliveryWithin(ctx, tx, actor.Actor, cases.DeliveryInput{TaskID: input.TaskID, CaseID: input.CaseID, ParticipationID: input.ParticipationID, SubjectID: input.SubjectID, ScopeVersion: &input.ScopeVersion, ResultRef: input.ResultRef, InterventionRefs: input.InterventionRefs, EvidenceRefs: input.EvidenceRefs})
		return err
	}
	tasks.ValidateTaskContext = func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, id string, references []any) error {
		rows := make([]cases.Object, len(references))
		for i, reference := range references {
			row, ok := reference.(map[string]any)
			if !ok {
				return fault.New("invalid_request", 400)
			}
			rows[i] = row
		}
		_, e := caseService.ValidateTaskContextWithin(ctx, tx, actor.Actor, id, rows)
		return e
	}
	caseService.TaskRead = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id string) (cases.Object, error) {
		return tasks.RequireTaskWithin(ctx, tx, &actor, id, false)
	}
	caseService.TaskWrite = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id string) (cases.Object, error) {
		return tasks.RequireTaskWithin(ctx, tx, &actor, id, true)
	}
	caseService.Participation = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, task, id string) (cases.Object, error) {
		return tasks.RequireParticipationWithin(ctx, tx, actor, task, id, false)
	}
	caseService.AttachCase = tasks.AttachCaseWithin
	outcome := &taskmaterials.OutcomeService{Service: tasks,
		ReadMessage: func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, id string, version int64) (taskmaterials.Object, error) {
			return rooms.ReadSelectedWithin(ctx, tx, chat.Actor{Device: &actor.Actor}, id, version)
		},
		RecheckMessage: func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, room, id string, version int64) (taskmaterials.Object, error) {
			return rooms.RequireSelectedWithin(ctx, tx, chat.Actor{Device: &actor.Actor}, room, id, version)
		},
		InspectAttachment: func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, id string) (taskmaterials.Object, error) {
			return files.InspectAttachmentWithin(ctx, tx, chat.Actor{Device: &actor.Actor}, id)
		},
		SelectAttachment: func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, id string) (taskmaterials.SelectedSource, error) {
			row, body, e := files.SelectAttachmentWithin(ctx, tx, chat.Actor{Device: &actor.Actor}, id)
			if e != nil {
				return taskmaterials.SelectedSource{}, e
			}
			author, okAuthor := row["subject_id"].(string)
			name, okName := row["name"].(string)
			media, okMedia := row["media_type"].(string)
			if !okAuthor || !okName || !okMedia {
				return taskmaterials.SelectedSource{}, fault.New("attachment_source_unavailable", 503)
			}
			return taskmaterials.SelectedSource{Source: map[string]any{"kind": "attachment", "id": row["id"], "version": 1, "sha256": row["sha256"], "roomId": row["room_id"]}, AuthorID: author, Size: int64(len(body)), Bytes: body, Name: name, MediaType: media, ScanResult: row["scan_result"]}, nil
		},
	}
	if storage != nil {
		outcome.Store = storage.Store
		outcome.Removals = &objectremoval.Service{Pool: pool, Endpoint: endpoint}
		if eraser, ok := storage.Store.(interface {
			Erase(context.Context, string) error
		}); ok {
			outcome.Erase = eraser.Erase
		}
	}
	return tasks, outcome, caseService, nil
}
func taskHandler(tasks *taskmaterials.Service, outcome *taskmaterials.OutcomeService, caseService *cases.Service, inbox *notifications.Service, rooms *chat.Service, moderators []string, next http.Handler, loaded ...func(*taskmaterials.CommentService, *taskmaterials.CommentGovernance)) http.Handler {
	caseHTTP := cases.Handler{Service: caseService, Next: next}
	if caseService.Devices != nil {
		caseHTTP.Devices = caseService.Devices
	}
	comments := &taskmaterials.CommentService{Service: tasks, IsBlockedWithin: inbox.IsBlockedWithin}
	governance := &taskmaterials.CommentGovernance{CommentService: comments, ModeratorIDs: moderators}
	for _, capture := range loaded {
		capture(comments, governance)
	}
	inbox.Readers = notifications.CurrentReaders{Task: tasks.NotificationReadWithin, Assistance: tasks.LegacyNotificationReadWithin, Comment: comments.NotificationReadWithin, CommentGovernance: governance.NotificationReadWithin, Chat: func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, candidate notifications.Object) (notifications.Object, error) {
		kind, _ := candidate["kind"].(string)
		id, _ := candidate["event_id"].(string)
		room, _ := candidate["room_id"].(string)
		return rooms.NotificationViewWithin(ctx, tx, actor, kind, id, room)
	}}
	return notifications.Handler{Service: inbox, Next: taskmaterials.CommentGovernanceHandler{Service: governance, Next: taskmaterials.CommentHandler{Service: comments, Next: publicwrites.Handler{Service: tasks.Writes, Next: taskmaterials.Handler{Task: tasks, Outcome: outcome, Next: caseHTTP}}}}}
}
