package publication

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Publisher interface {
	Current(context.Context) (*Current, error)
	Prepare(context.Context, string, Snapshot) (Artifact, error)
	Activate(context.Context, Artifact) error
}

// Authority resolves a recorded operator through current stored-principal,
// admission, management fences and business permission authority. No browser
// session or role snapshot belongs in a queued publication.
type Authority interface {
	Revalidate(context.Context, pgx.Tx, string, string) error
}
type Service struct {
	Pool                   *pgxpool.Pool
	Endpoint, PublicOrigin string
	Publisher              Publisher
	Authority              Authority
	Now                    func() time.Time
	stopped                atomic.Bool
}
type row struct {
	ID, State, Operator string
	Sequence            int64
	Snapshot            []byte
	Result, Error       Object
	Base                *string
}

const rowColumns = "id::text,state,requested_by,sequence,snapshot,result,error,base_publication_id::text"

func readRow(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id, endpoint string, lock bool) (row, error) {
	var r row
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	e := db.QueryRow(ctx, "SELECT "+rowColumns+" FROM site_publications_v1 WHERE id=$1 AND endpoint=$2"+suffix, id, endpoint).Scan(&r.ID, &r.State, &r.Operator, &r.Sequence, &r.Snapshot, &r.Result, &r.Error, &r.Base)
	return r, e
}
func terminal(r row) bool { return r.Error != nil && r.Error["retryable"] == false }
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (s *Service) Stop() { s.stopped.Store(true) }
func (s *Service) authorize(ctx context.Context, tx pgx.Tx, r row) error {
	if s.Authority == nil {
		return fault.New("operations_authorization_unavailable", 503)
	}
	action := "cms.publish"
	if r.Base != nil {
		var bridge bool
		e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_system_general_publications_v1 WHERE endpoint=$1 AND operation_id=$2 AND publication_id=$2 AND operator_id=$3 AND input->>'expectedPublicationId'=$4)`, s.Endpoint, r.ID, r.Operator, *r.Base).Scan(&bridge)
		if e != nil {
			return e
		}
		if !bridge {
			return fault.New("operations_authorization_unavailable", 503)
		}
		action = "system.settings.apply"
	}
	return s.Authority.Revalidate(ctx, tx, r.Operator, action)
}
func (s *Service) locked(ctx context.Context, tx pgx.Tx, r row, clear, checkStop bool) (row, string, error) {
	if e := s.authorize(ctx, tx, r); e != nil {
		return row{}, "", e
	}
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912341)"); e != nil {
		return row{}, "", e
	}
	live, e := readRow(ctx, tx, r.ID, s.Endpoint, true)
	if errors.Is(e, pgx.ErrNoRows) {
		return row{}, "superseded", nil
	}
	if e != nil {
		return row{}, "", e
	}
	if terminal(live) || checkStop && s.stopped.Load() {
		return live, "superseded", nil
	}
	if live.State == "published" {
		return live, "published", nil
	}
	var newer bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM site_publications_v1 WHERE endpoint=$1 AND sequence>$2 AND state='published')", s.Endpoint, r.Sequence).Scan(&newer); e != nil {
		return live, "", e
	}
	if newer {
		body, _ := json.Marshal(Object{"code": "site_publication_superseded", "message": "已有更新的内容发布；可从所需版本发起新发布。", "retryable": false})
		sql := "UPDATE site_publications_v1 SET state='failed',error=$2,updated_at=$3 WHERE id=$1"
		if clear {
			sql = "UPDATE site_publications_v1 SET state='failed',result=NULL,error=$2,updated_at=$3 WHERE id=$1"
		}
		_, e = tx.Exec(ctx, sql, r.ID, body, s.now())
		return live, "superseded", e
	}
	return live, "", nil
}
func (s *Service) published(ctx context.Context, tx pgx.Tx, r row, version string, reconcile bool) error {
	result, _ := json.Marshal(Object{"publicUrl": s.PublicOrigin + "/", "siteVersion": version, "publicationId": r.ID})
	published := "$3"
	if reconcile {
		published = "COALESCE(published_at,$3)"
	}
	_, e := tx.Exec(ctx, "UPDATE site_publications_v1 SET state='published',result=$2,error=NULL,published_at="+published+",updated_at=$3 WHERE id=$1", r.ID, result, s.now())
	return e
}
func (s *Service) Execute(ctx context.Context, id string) (Object, error) {
	if s.Pool == nil || s.Publisher == nil || s.Endpoint == "" || s.PublicOrigin == "" {
		return nil, fault.New("site_publication_unavailable", 503)
	}
	if !uuidValid(id) {
		return nil, fault.New("invalid_site_publication", 400)
	}
	r, e := readRow(ctx, s.Pool, id, s.Endpoint, false)
	if errors.Is(e, pgx.ErrNoRows) {
		return Object{"state": "superseded"}, nil
	}
	if e != nil {
		return nil, e
	}
	if r.State == "published" || terminal(r) {
		return Object{"state": r.State}, nil
	}
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) { e := s.authorize(ctx, tx, r); return e == nil, e })
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	tag, e := s.Pool.Exec(ctx, "UPDATE site_publications_v1 SET state='building',attempts=attempts+1,error=NULL,updated_at=$2 WHERE id=$1 AND state<>'published' AND (error IS NULL OR error->>'retryable'<>'false')", id, s.now())
	if e != nil {
		return nil, e
	}
	if tag.RowsAffected() == 0 {
		return Object{"state": "superseded"}, nil
	}
	result, e := s.executeClaimed(ctx, r)
	if e == nil {
		return result, nil
	}
	// The pointer may have moved while its acknowledgement was lost. Preserve
	// activationPending when current cannot be established, and reconcile the
	// same publication before any rebuild on the next original job attempt.
	recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	current, currentError := s.Publisher.Current(recovery)
	known := currentError == nil
	if current == nil || current.PublicationID != id {
		failure := Object{"code": "site_publication_failed", "message": "发布尚未完成，可以重试或查看当前发布状态。", "retryable": true}
		if fault.Code(e) == "site_publication_base_changed" {
			failure = Object{"code": "site_publication_base_changed", "message": "官网内容已有更新，请读取后应用。", "retryable": false}
		}
		body, _ := json.Marshal(failure)
		if _, updateError := s.Pool.Exec(recovery, `UPDATE site_publications_v1 SET state='failed',error=$2,updated_at=$3,result=CASE WHEN $4 THEN NULL ELSE result END WHERE id=$1 AND state<>'published' AND (error IS NULL OR error->>'retryable'<>'false')`, id, body, s.now(), known); updateError != nil {
			return nil, updateError
		}
	}
	if fault.Code(e) == "site_publication_base_changed" {
		return nil, fault.New("site_publication_base_changed", 409)
	}
	return nil, fault.New("site_publication_failed", 503)
}
func (s *Service) executeClaimed(ctx context.Context, r row) (Object, error) {
	current, e := s.Publisher.Current(ctx)
	if e != nil {
		return nil, e
	}
	if current != nil && current.PublicationID == r.ID {
		return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			_, state, e := s.locked(ctx, tx, r, true, false)
			if e != nil {
				return nil, e
			}
			if state != "" {
				return Object{"state": state}, nil
			}
			actual, e := s.Publisher.Current(ctx)
			if e != nil {
				return nil, e
			}
			if actual == nil || actual.PublicationID != r.ID {
				return nil, fault.New("site_publication_failed", 503)
			}
			e = s.published(ctx, tx, r, actual.SiteVersion, true)
			return Object{"state": "published"}, e
		})
	}
	snapshot, e := ParseSnapshot(r.Snapshot)
	if e != nil {
		return nil, e
	}
	artifact, e := s.Publisher.Prepare(ctx, r.ID, snapshot)
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	prepared, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (string, error) {
		_, state, e := s.locked(ctx, tx, r, false, true)
		if e != nil {
			return "", e
		}
		if state != "" {
			return state, nil
		}
		if e = ctx.Err(); e != nil {
			return "", e
		}
		body, _ := json.Marshal(Object{"publicationId": r.ID, "siteVersion": artifact.SiteVersion, "activationPending": true})
		_, e = tx.Exec(ctx, "UPDATE site_publications_v1 SET result=$2,updated_at=$3 WHERE id=$1", r.ID, body, s.now())
		return "prepared", e
	})
	if e != nil {
		return nil, e
	}
	if prepared != "prepared" {
		return Object{"state": prepared}, nil
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		live, state, e := s.locked(ctx, tx, r, true, true)
		if e != nil {
			return nil, e
		}
		if state != "" {
			return Object{"state": state}, nil
		}
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		if e = s.authorize(ctx, tx, r); e != nil {
			return nil, e
		}
		var active *Current
		if live.Base != nil {
			active, e = s.Publisher.Current(ctx)
			if e != nil {
				return nil, e
			}
			if active == nil || active.PublicationID != r.ID && active.PublicationID != *live.Base {
				return nil, fault.New("site_publication_base_changed", 409)
			}
		}
		version := artifact.SiteVersion
		if active != nil && active.PublicationID == r.ID {
			version = active.SiteVersion
		} else if e = s.Publisher.Activate(ctx, artifact); e != nil {
			return nil, e
		}
		e = s.published(ctx, tx, r, version, false)
		return Object{"state": "published"}, e
	})
}
