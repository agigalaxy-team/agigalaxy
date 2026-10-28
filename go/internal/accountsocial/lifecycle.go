package accountsocial

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// SubjectExportWithin is consumed only after the existing lifecycle owner grant
// and snapshot boundary have been authorized by the caller. It exports the two
// original ID-owned categories, without adopting linked-account choices.
func SubjectExportWithin(ctx context.Context, tx pgx.Tx, subject, category, after string, cutoff time.Time, limit int) ([]Object, error) {
	if !subjectPattern.MatchString(subject) || limit < 1 {
		return nil, fault.New("invalid_request", 400)
	}
	table, fields, key := "reading_bookmarks_v1", "t.id,t.subject_id,t.reference_key,t.reference,t.saved,t.revision,t.created_at,t.saved_at,t.updated_at", "t.id::text"
	switch category {
	case "reading-bookmarks":
	case "reading-bookmark-operations":
		table = "reading_bookmark_operations_v1"
		fields = "t.subject_id,t.operation_id,t.request_hash,t.result,t.created_at"
		key = "t.operation_id::text"
	default:
		return nil, fault.New("invalid_request", 400)
	}
	result, e := rows(ctx, tx, `SELECT `+fields+` FROM `+table+` t WHERE t.subject_id=$1 AND t.created_at<=$2 AND ($3::text='' OR `+key+`>$3) ORDER BY `+key+` LIMIT $4`, subject, cutoff, after, limit)
	if e != nil {
		return nil, e
	}
	for _, r := range result {
		for _, key := range []string{"created_at", "saved_at", "updated_at"} {
			if v, ok := r[key]; ok {
				r[key] = date(v)
			}
		}
	}
	return result, nil
}

// DeleteSubjectWithin is an explicit original ID-erasure consumer. The caller
// owns the existing confirmed intent and transaction; this starts no queue and
// deletes no linked account, source content or independently authored material.
func DeleteSubjectWithin(ctx context.Context, tx pgx.Tx, subject string, limit int) (Object, error) {
	if !subjectPattern.MatchString(subject) || limit < 1 {
		return nil, fault.New("invalid_request", 400)
	}
	out := Object{}
	for _, table := range []string{"reading_bookmark_operations_v1", "reading_bookmarks_v1"} {
		key := "operation_id"
		if table == "reading_bookmarks_v1" {
			key = "id"
		}
		tag, e := tx.Exec(ctx, `DELETE FROM `+table+` WHERE ctid IN (SELECT ctid FROM `+table+` WHERE subject_id=$1 ORDER BY `+key+` LIMIT $2)`, subject, limit)
		if e != nil {
			return nil, e
		}
		out[table] = tag.RowsAffected()
	}
	return out, nil
}

// Account choice tables already have the original ON DELETE CASCADE account
// foreign keys. An identity's erasure is never an instruction to delete them.
func AccountDependentTables() []string {
	return []string{"account_follows_v1", "account_follow_operations_v1", "account_reading_bookmarks_v2", "account_reading_bookmark_operations_v2"}
}
