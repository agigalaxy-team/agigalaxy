package feedback

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type ownerDataIntent struct {
	operation, endpoint, account, kind, cutoff, state string
	sequence                                          int64
	feedbackCount, attachmentCount                    int
	metadataDeleted                                   bool
	created, updated                                  time.Time
}

const ownerIntentColumns = `operation_id::text,endpoint,account_id::text,kind,cutoff_sequence::text,state,sequence,feedback_count,attachment_count,metadata_deleted,created_at,updated_at`

func scanOwnerIntent(row pgx.Row) (r ownerDataIntent, e error) {
	e = row.Scan(&r.operation, &r.endpoint, &r.account, &r.kind, &r.cutoff, &r.state, &r.sequence, &r.feedbackCount, &r.attachmentCount, &r.metadataDeleted, &r.created, &r.updated)
	return
}
func ownerDataInvalid() error { return fault.New("invalid_account_feedback_data_request", 400) }
func ownerIntentInput(raw []byte) (string, error) {
	var x struct {
		OperationID string `json:"operationId"`
	}
	if protocol.Decode(raw, &x) != nil || !uuidPattern.MatchString(x.OperationID) {
		return "", ownerDataInvalid()
	}
	return x.OperationID, nil
}
func (s *Service) ownerIntent(ctx context.Context, tx pgx.Tx, account, operation string) (ownerDataIntent, error) {
	return scanOwnerIntent(tx.QueryRow(ctx, "SELECT "+ownerIntentColumns+" FROM account_feedback_data_operations_v1 WHERE operation_id=$1 AND endpoint=$2 AND account_id=$3", operation, s.Endpoint, account))
}
func (s *Service) ownerIntentView(ctx context.Context, tx pgx.Tx, r ownerDataIntent, replayed bool) (Object, error) {
	var pending, removed, unknown int
	e := tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE state IN('pending','removing'))::int,count(*) FILTER(WHERE state='removed')::int,count(*) FILTER(WHERE state='result-unknown')::int FROM account_feedback_data_items_v1 WHERE operation_id=$1`, r.operation).Scan(&pending, &removed, &unknown)
	if e != nil {
		return nil, e
	}
	var objectRemoved any
	if r.attachmentCount > 0 && removed == r.attachmentCount {
		objectRemoved = true
	}
	now := s.now().Unix()
	return Object{"state": "recorded", "operationId": r.operation, "kind": r.kind, "phase": r.state, "scope": "own-submitted-feedback-at-selection", "feedbackCount": r.feedbackCount, "attachmentCount": r.attachmentCount, "metadataDeleted": r.metadataDeleted, "attachments": Object{"pending": pending, "removed": removed, "resultUnknown": unknown, "objectRemoved": objectRemoved, "physicalBlocksReleased": nil}, "recordedAt": iso(r.created), "updatedAt": iso(r.updated), "replayed": replayed, "checkedAt": now, "readExpiresAt": now + 30}, nil
}

// OwnerDataBegin records only this currently authorized owner's existing
// selection. The original restricted SQL function owns metadata erasure.
func (s *Service) OwnerDataBegin(ctx context.Context, account string, raw []byte, kind string) (Object, error) {
	operation, e := ownerIntentInput(raw)
	if e != nil {
		return nil, e
	}
	if kind != "export" && kind != "delete" {
		return nil, ownerDataInvalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912395))", s.Endpoint+":feedback-intake:"+account); e != nil {
			return nil, e
		}
		prior, e := scanOwnerIntent(tx.QueryRow(ctx, "SELECT "+ownerIntentColumns+" FROM account_feedback_data_operations_v1 WHERE operation_id=$1", operation))
		if e == nil {
			if prior.endpoint != s.Endpoint || prior.account != account || prior.kind != kind {
				return nil, fault.New("account_feedback_operation_conflict", 409)
			}
			return s.ownerIntentView(ctx, tx, prior, true)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		var cutoff string
		var count, files int
		e = tx.QueryRow(ctx, `SELECT COALESCE(max(sequence),0)::text,count(*)::int FROM operations_feedback_v1 WHERE endpoint=$1 AND account_id=$2 AND owner_deleted_at IS NULL`, s.Endpoint, account).Scan(&cutoff, &count)
		if e != nil {
			return nil, e
		}
		e = tx.QueryRow(ctx, `SELECT count(*)::int FROM feedback_attachments_v1 a JOIN operations_feedback_v1 f ON f.id=a.feedback_id AND f.endpoint=a.endpoint AND f.account_id=a.account_id AND f.submission_operation_id=a.submission_operation_id WHERE f.endpoint=$1 AND f.account_id=$2 AND f.owner_deleted_at IS NULL AND f.sequence<=$3::bigint`, s.Endpoint, account, cutoff).Scan(&files)
		if e != nil {
			return nil, e
		}
		state := "ready"
		if kind == "delete" {
			state = "pending"
		}
		now := s.now()
		_, e = tx.Exec(ctx, `INSERT INTO account_feedback_data_operations_v1(operation_id,endpoint,account_id,kind,cutoff_sequence,state,feedback_count,attachment_count,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, operation, s.Endpoint, account, kind, cutoff, state, count, files, now)
		if e != nil {
			return nil, e
		}
		if kind == "delete" {
			if _, e = tx.Exec(ctx, "SELECT public.galaxy_account_erase_feedback_data($1,$2,$3)", s.Endpoint, account, operation); e != nil {
				return nil, e
			}
			if e = s.queueOwnerDeletionWithin(ctx, tx, operation); e != nil {
				return nil, e
			}
		}
		r, e := s.ownerIntent(ctx, tx, account, operation)
		if e != nil {
			return nil, e
		}
		return s.ownerIntentView(ctx, tx, r, false)
	})
}
func (s *Service) OwnerDataOperation(ctx context.Context, account, operation string) (Object, error) {
	if !uuidPattern.MatchString(operation) {
		return nil, ownerDataInvalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		r, e := s.ownerIntent(ctx, tx, account, operation)
		if errors.Is(e, pgx.ErrNoRows) {
			now := s.now().Unix()
			return Object{"state": "not-recorded", "operationId": operation, "checkedAt": now, "readExpiresAt": now + 30}, nil
		}
		if e != nil {
			return nil, e
		}
		return s.ownerIntentView(ctx, tx, r, false)
	})
}
func (s *Service) ownerExport(ctx context.Context, tx pgx.Tx, account, operation string) (ownerDataIntent, error) {
	r, e := s.ownerIntent(ctx, tx, account, operation)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && r.kind != "export" {
		return r, fault.New("not_found", 404)
	}
	return r, e
}
func ownerSequence(value string) bool {
	if value == "" {
		return false
	}
	n, e := strconv.ParseInt(value, 10, 64)
	return e == nil && n >= 0 && strconv.FormatInt(n, 10) == value
}
func (s *Service) OwnerDataExportPage(ctx context.Context, account, operation, after string, limit int) (Object, error) {
	if !uuidPattern.MatchString(operation) || !ownerSequence(after) || limit < 1 || limit > 50 {
		return nil, ownerDataInvalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		intent, e := s.ownerExport(ctx, tx, account, operation)
		if e != nil {
			return nil, e
		}
		cursor, _ := strconv.ParseInt(after, 10, 64)
		cutoff, _ := strconv.ParseInt(intent.cutoff, 10, 64)
		if cursor > cutoff {
			return nil, ownerDataInvalid()
		}
		rows, e := tx.Query(ctx, `SELECT f.id::text,f.sequence,f.title,f.body,f.submitted_category,f.submitted_module,f.created_at,f.owner_deleted_at FROM operations_feedback_v1 f WHERE f.endpoint=$1 AND f.account_id=$2 AND f.sequence>$3::bigint AND f.sequence<=$4::bigint AND (f.owner_deleted_at IS NULL OR EXISTS(SELECT 1 FROM account_feedback_data_operations_v1 d WHERE d.operation_id=f.owner_delete_operation_id AND d.sequence>$6::bigint)) ORDER BY f.sequence LIMIT $5`, s.Endpoint, account, after, intent.cutoff, limit+1, intent.sequence)
		if e != nil {
			return nil, e
		}
		type exported struct {
			id                    string
			sequence              int64
			title, body, category *string
			module                string
			created               time.Time
			deleted               *time.Time
		}
		selected := []exported{}
		for rows.Next() {
			var r exported
			if e = rows.Scan(&r.id, &r.sequence, &r.title, &r.body, &r.category, &r.module, &r.created, &r.deleted); e != nil {
				rows.Close()
				return nil, e
			}
			selected = append(selected, r)
		}
		rows.Close()
		if e = rows.Err(); e != nil {
			return nil, e
		}
		items := []Object{}
		var next any
		if len(selected) > limit {
			next = strconv.FormatInt(selected[limit-1].sequence, 10)
			selected = selected[:limit]
		}
		for _, r := range selected {
			if r.deleted != nil {
				items = append(items, Object{"id": r.id, "state": "deleted", "submittedAt": iso(r.created), "title": nil, "body": nil, "category": nil, "module": nil, "attachments": []Object{}})
				continue
			}
			if s.Attachments == nil {
				return nil, fault.New("attachment_service_unavailable", 503)
			}
			files, e := s.Attachments.List(ctx, tx, r.id)
			if e != nil {
				return nil, e
			}
			out := []Object{}
			for _, file := range files {
				var content any
				if file["availability"] == "available" {
					content = "/v1/account/data/feedback/exports/" + operation + "/attachments/" + file["id"].(string) + "/content"
				}
				out = append(out, Object{"id": file["id"], "name": file["name"], "mediaType": file["mediaType"], "byteSize": file["byteSize"], "sha256": file["sha256"], "state": file["state"], "availability": file["availability"], "expiresAt": file["expiresAt"], "contentPath": content})
			}
			items = append(items, Object{"id": r.id, "state": "available", "submittedAt": iso(r.created), "title": r.title, "body": r.body, "category": r.category, "module": r.module, "attachments": out})
		}
		now := s.now().Unix()
		return Object{"operationId": operation, "accountId": account, "scope": "own-submitted-feedback-at-selection", "items": items, "nextAfter": next, "selectedAt": iso(intent.created), "checkedAt": now, "readExpiresAt": now + 30}, nil
	})
}
