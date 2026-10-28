package filegovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Actor = operationspermissions.Actor
type FileAdapter struct {
	Store           attachments.Store
	Policy          attachments.Policy
	Available       func() bool
	AuthorPending   func(context.Context, pgx.Tx, Object) (bool, error)
	RestoreBlocked  func(context.Context, pgx.Tx, Object, int64) (*string, error)
	ForumPermission func(context.Context, pgx.Tx, string, string, string, string) (bool, error)
}
type Service struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Authority       operationspermissions.Authority
	Duty            operationspermissions.DutyAuthority
	StoredAuthority operationspermissions.StoredPersonAuthority
	PrincipalWithin func(context.Context, pgx.Tx, Actor) error
	Chat, Forum     *FileAdapter
	Now             func() time.Time
	Diagnostic      func(Object)
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) stamp() time.Time { return time.Unix(s.now(), 0) }
func (s *Service) adapter(kind string, required bool) (*FileAdapter, error) {
	if _, e := table(kind); e != nil {
		return nil, e
	}
	a := s.Chat
	if kind == "forum" {
		a = s.Forum
	}
	if a == nil && required {
		return nil, fail("attachment_service_unavailable", 503)
	}
	return a, nil
}
func (s *Service) domain() *businessadmin.Domain {
	return &businessadmin.Domain{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Duty: s.Duty, PrincipalWithin: s.PrincipalWithin, Now: s.Now, Permissions: func(action string, _ Object) []string { return []string{permission(action)} }}
}
func (s *Service) fresh(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	if s == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	return s.domain().Fresh(ctx, tx, a, permission)
}
func (s *Service) duty() operationspermissions.DutyAuthority { return s.domain().DutyAuthority() }
func (s *Service) isDuty(a Actor) bool                       { return s.domain().IsDuty(a) }
func (s *Service) operation(ctx context.Context, tx pgx.Tx, a Actor, action string, selection Object) (Actor, error) {
	return s.domain().Operation(ctx, tx, a, action, selection)
}
func (s *Service) principal(ctx context.Context, tx pgx.Tx, a Actor) error {
	return s.domain().Principal(ctx, tx, a)
}
func permission(action string) string {
	switch action {
	case "files-query", "file-read", "file-cleanup-read", "file-access-read":
		return "files.read"
	case "file-retry":
		return "files.scan.retry"
	case "file-cleanup-create", "file-cleanup-cancel":
		return "files.cleanup.plan"
	case "file-cleanup-approve":
		return "files.cleanup.approve"
	case "file-access-stop":
		return "files.access.stop"
	case "file-access-restore":
		return "files.access.restore"
	}
	return ""
}
func (s *Service) record(ctx context.Context, tx pgx.Tx, a Actor, action string, selection, result Object, operationID any) error {
	return s.domain().Record(ctx, tx, a, action, selection, result, operationID)
}
func (s *Service) run(ctx context.Context, a Actor, action string, selection Object, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	return s.domain().Run(ctx, a, action, selection, fn)
}
func (s *Service) command(ctx context.Context, a Actor, action string, selection Object, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	return s.domain().Command(ctx, a, action, selection, fn)
}

// fileRow reads only a trusted plan/file locator; it grants no source or operator authority.
func (s *Service) fileRow(ctx context.Context, tx pgx.Tx, kind, id string, write bool) (Object, error) {
	name, e := table(kind)
	if e != nil {
		return nil, e
	}
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(a) FROM "+name+" a WHERE id=$1"+lock, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fail("not_found", 404)
	}
	return r, nil
}
func (s *Service) scopedRow(ctx context.Context, tx pgx.Tx, kind, id string, write bool) (Object, error) {
	r, e := s.fileRow(ctx, tx, kind, id, write)
	if e != nil {
		return nil, e
	}
	account := str(r, "account_id")
	if kind == "chat" {
		subject := str(r, "subject_id")
		if len(subject) > 8 && subject[:8] == "account:" {
			account = subject[8:]
		}
	}
	if account != "" {
		var exists bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id::text=$1 AND endpoint=$2)", account, s.Endpoint).Scan(&exists)
		if e != nil {
			return nil, e
		}
		if !exists {
			return nil, fail("not_found", 404)
		}
	}
	return r, nil
}
func (s *Service) authorPending(ctx context.Context, tx pgx.Tx, kind string, r Object) (bool, error) {
	a, e := s.adapter(kind, false)
	if e != nil {
		return false, e
	}
	if a == nil || a.AuthorPending == nil {
		return false, nil
	}
	return a.AuthorPending(ctx, tx, r)
}
func (s *Service) NamesWithin(ctx context.Context, tx pgx.Tx, ids []string) (map[string]any, error) {
	return s.domain().NamesWithin(ctx, tx, ids)
}
