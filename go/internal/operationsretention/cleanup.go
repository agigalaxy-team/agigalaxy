package operationsretention

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) clean(ctx context.Context, tx pgx.Tx, target string, at int64) (Object, error) {
	if s.CleanWithin != nil {
		return s.CleanWithin(ctx, tx, target, at)
	}
	switch target {
	case "private-conversation-archives":
		return accountarchive.CleanupRetentionWithin(ctx, tx, at)
	case "data-exports":
		return CleanupExpiredExportsWithin(ctx, tx, at)
	case "information-watches":
		return (&information.Watches{Now: func() time.Time { return time.Unix(at, 0) }}).PurgeExpiredWithin(ctx, tx)
	}
	return nil, invalid()
}

// SweepWithin is the existing scheduled cleanup consumer, called by the
// owning Worker's minute sweep. Only actual successful counts are observed.
func (s *Service) SweepWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	out := Object{}
	for _, target := range targets {
		counts, e := s.clean(ctx, tx, target, at)
		if e != nil {
			return nil, e
		}
		if !resultValid(target, counts) {
			return nil, invalid()
		}
		if e = s.RecordMaintenanceWithin(ctx, tx, target, counts, nil); e != nil {
			return nil, e
		}
		for key, value := range counts {
			out[key] = value
		}
	}
	return out, nil
}

// CleanupExpiredExportsWithin is the original bounded export sweep. It removes
// expired/revoked request rows, never a payload file or another retained record.
func CleanupExpiredExportsWithin(ctx context.Context, tx pgx.Tx, at int64) (Object, error) {
	tag, e := tx.Exec(ctx, `DELETE FROM data_exports WHERE id IN(SELECT id FROM data_exports WHERE expires_at<=$1 OR revoked_at IS NOT NULL ORDER BY expires_at LIMIT 100)`, time.Unix(at, 0))
	if e != nil {
		return nil, e
	}
	return Object{"removed": tag.RowsAffected(), "payloadFilesStored": false}, nil
}
func resultValid(target string, result Object) bool {
	var fields []string
	switch target {
	case "private-conversation-archives":
		fields = []string{"privateConversationArchives"}
	case "data-exports":
		fields = []string{"removed", "payloadFilesStored"}
	case "information-watches":
		fields = []string{"informationChangeReceipts", "informationWatchReceipts"}
	default:
		return false
	}
	if len(result) != len(fields) {
		return false
	}
	for _, k := range fields {
		v, exists := result[k]
		if !exists {
			return false
		}
		if k == "payloadFilesStored" {
			if v != false {
				return false
			}
		} else if !integer(v, 0, 9007199254740991) {
			return false
		}
	}
	return true
}
func (s *Service) RecordMaintenanceWithin(ctx context.Context, tx pgx.Tx, target string, result Object, errorCode *string) error {
	if !has(targets, target) {
		return invalid()
	}
	var code any
	if errorCode != nil {
		if !has([]string{"retention_cleanup_failed", "operations_permission_denied", "business_admin_denied", "identity_directory_unavailable", "operations_authorization_unavailable"}, *errorCode) {
			return invalid()
		}
		code = *errorCode
		result = nil
	} else if !resultValid(target, result) {
		return invalid()
	}
	_, e := tx.Exec(ctx, `INSERT INTO operations_retention_observations_v1(endpoint,target,component,result,error_code,checked_at) VALUES($1,$2,'worker',$3,$4,$5) ON CONFLICT(endpoint,target,component) DO UPDATE SET result=EXCLUDED.result,error_code=EXCLUDED.error_code,checked_at=EXCLUDED.checked_at`, s.Endpoint, target, result, code, s.now())
	return e
}
func (s *Service) Status(ctx context.Context, a Actor) (Object, error) {
	if e := s.readable(ctx, a); e != nil {
		return nil, e
	}
	items := []any{}
	at := s.now()
	for _, target := range targets {
		var count int64
		var label, expiry string
		var maxRows, maxRoots any = 100, nil
		switch target {
		case "private-conversation-archives":
			label, expiry = "已到期的私有会话副本", "owner-configured-expires-at"
			if e := s.Pool.QueryRow(ctx, `SELECT count(*) FROM private_conversation_archives_v1 WHERE expires_at<=$1`, at).Scan(&count); e != nil {
				return nil, e
			}
		case "data-exports":
			label, expiry = "已到期或撤销的导出请求", "existing-expires-at-or-revoked"
			if e := s.Pool.QueryRow(ctx, `SELECT count(*) FROM data_exports WHERE expires_at<=$1 OR revoked_at IS NOT NULL`, at).Scan(&count); e != nil {
				return nil, e
			}
		case "information-watches":
			label, expiry = "到期的资料关注回执", "existing-90-day-receipts"
			maxRows, maxRoots = nil, 100
			if e := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM information_watch_changes_v2 WHERE expires_at<=$1)+(SELECT count(*) FROM information_watches_v2 WHERE COALESCE(ended_at,expires_at)<=$2)`, at, at.Add(-90*24*time.Hour)).Scan(&count); e != nil {
				return nil, e
			}
		}
		rows, e := s.Pool.Query(ctx, `SELECT to_jsonb(o) FROM operations_retention_observations_v1 o WHERE endpoint=$1 AND target=$2 ORDER BY component`, s.Endpoint, target)
		if e != nil {
			return nil, e
		}
		observations, e := collect(rows)
		if e != nil {
			return nil, e
		}
		views := []any{}
		for _, r := range observations {
			views = append(views, Object{"component": r["component"], "result": r["result"], "errorCode": r["error_code"], "checkedAt": iso(r["checked_at"])})
		}
		items = append(items, Object{"key": target, "label": label, "backlog": count, "maximumRowsPerRun": maxRows, "maximumRootsPerRun": maxRoots, "expiry": expiry, "observations": views})
	}
	return Object{"policyVersion": PolicyVersion, "targets": items, "checkedAt": at.Unix(), "scope": "configured-business-database"}, nil
}
