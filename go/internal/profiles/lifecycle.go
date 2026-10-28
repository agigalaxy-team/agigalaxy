package profiles

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// ExportSubjectWithin is the original profile-statements own-data dataset.
// The caller holds the existing export grant/snapshot; expired audience sharing
// does not erase an owner's original declarations or authorize public access.
func ExportSubjectWithin(ctx context.Context, tx pgx.Tx, subject, after string, cutoff time.Time, limit int) ([]Object, error) {
	if !subjectPattern.MatchString(subject) || limit < 1 {
		return nil, fault.New("invalid_request", 400)
	}
	rr, e := tx.Query(ctx, `SELECT row_to_json(t) FROM (SELECT id,subject_id,revision,consent_id,payload_text,payload_hash,created_at FROM profile_statements WHERE subject_id=$1 AND created_at<=$2 AND ($3::text='' OR id::text>$3) ORDER BY id::text LIMIT $4) t`, subject, cutoff, after, limit)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	out := []Object{}
	for rr.Next() {
		var raw []byte
		if e = rr.Scan(&raw); e != nil {
			return nil, e
		}
		var r Object
		if e = protocol.Decode(raw, &r); e != nil {
			return nil, e
		}
		if t, e := time.Parse(time.RFC3339Nano, str(r, "created_at")); e == nil {
			r["created_at"] = t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		out = append(out, r)
	}
	return out, rr.Err()
}

// DeleteSubjectWithin is an explicit consumer for the existing confirmed ID
// deletion executor. It starts no queue and leaves identity/control/Consent FK
// dependency decisions to that executor, preserving real database failures.
func DeleteSubjectWithin(ctx context.Context, tx pgx.Tx, subject string, limit int) (Object, error) {
	if !subjectPattern.MatchString(subject) || limit < 1 {
		return nil, fault.New("invalid_request", 400)
	}
	tag, e := tx.Exec(ctx, `DELETE FROM profile_statements WHERE ctid IN (SELECT ctid FROM profile_statements WHERE subject_id=$1 ORDER BY id LIMIT $2)`, subject, limit)
	if e != nil {
		return nil, e
	}
	return Object{"profile_statements": tag.RowsAffected()}, nil
}
