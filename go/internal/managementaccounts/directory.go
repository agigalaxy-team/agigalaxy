package managementaccounts

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

// Source describes a complete published observation even while a replacement
// fails. It does not claim an atomic native-identity snapshot.
func (s *Directory) Source(ctx context.Context, q Querier) (Object, error) {
	if q == nil {
		q = s.Pool
	}
	row, e := optionalObject(ctx, q, `SELECT to_jsonb(r) FROM (SELECT d.*,g.observed_count FROM operations_management_directory_v1 d LEFT JOIN operations_management_generations_v1 g ON g.id=d.generation_id WHERE d.endpoint=$1) r`, s.Endpoint)
	if e != nil {
		return nil, e
	}
	configured := s.Reader != nil
	matching := configured && str(row["issuer"]) == s.Reader.Issuer()
	ready := matching && str(row["generation_id"]) != ""
	state := "unavailable"
	lease, _ := time.Parse(time.RFC3339Nano, str(row["lease_until"]))
	if !configured {
		state = "not-configured"
	} else if matching && str(row["sync_id"]) != "" && lease.After(s.now()) {
		state = "syncing"
	} else if ready && row["last_error"] == nil {
		state = "ready"
	}
	out := Object{"state": state, "coverage": "not-ready", "generationId": nil, "asOf": nil, "lastError": nil, "totalObserved": nil, "atomicSourceSnapshot": false}
	if matching {
		out["lastError"] = row["last_error"]
	}
	if ready {
		out["coverage"] = "complete-generation"
		out["generationId"] = row["generation_id"]
		out["asOf"] = nullableStamp(row["last_completed_at"])
		out["totalObserved"] = row["observed_count"]
	}
	return out, nil
}

func (s *Directory) Sync(ctx context.Context) (Object, error) {
	if s.Reader == nil {
		return Object{"state": "not-configured"}, nil
	}
	id, issuer, at := uuid.NewString(), s.Reader.Issuer(), s.now()
	claimed := false
	e := within(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912460))`, s.Endpoint); e != nil {
			return e
		}
		old, e := optionalObject(ctx, tx, `SELECT to_jsonb(d) FROM operations_management_directory_v1 d WHERE endpoint=$1 FOR UPDATE`, s.Endpoint)
		if e != nil {
			return e
		}
		lease, _ := time.Parse(time.RFC3339Nano, str(old["lease_until"]))
		if str(old["sync_id"]) != "" && lease.After(s.now()) {
			return nil
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_management_directory_v1(endpoint,issuer,sync_id,lease_until,last_started_at) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(endpoint) DO UPDATE SET issuer=$2,generation_id=CASE WHEN operations_management_directory_v1.issuer=$2 THEN operations_management_directory_v1.generation_id ELSE NULL END,
   sync_id=$3,lease_until=$4,last_started_at=$5,last_error=NULL`, s.Endpoint, issuer, id, s.now().Add(60*time.Second), at)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_management_generations_v1(id,endpoint,issuer,state,started_at) VALUES($1,$2,$3,'building',$4)`, id, s.Endpoint, issuer, at)
		if e == nil {
			claimed = true
		}
		return e
	})
	if e != nil {
		return nil, e
	}
	if !claimed {
		return Object{"state": "syncing"}, nil
	}
	var observed, raw int64
	e = func() error {
		before, e := s.Reader.Count(ctx)
		if e != nil {
			return e
		}
		for first := int64(0); ; first += 20 {
			if first > before+20 {
				return changed()
			}
			page, e := s.Reader.Page(ctx, first, 20)
			if e != nil {
				return e
			}
			raw += page.RawCount
			e = within(ctx, s.Pool, func(tx pgx.Tx) error {
				var syncID string
				if e := tx.QueryRow(ctx, `SELECT sync_id FROM operations_management_directory_v1 WHERE endpoint=$1 FOR UPDATE`, s.Endpoint).Scan(&syncID); e != nil {
					return e
				}
				if syncID != id {
					return changed()
				}
				for _, u := range page.Items {
					var createdAt *time.Time
					if u.CreatedAt != nil {
						t, e := time.Parse(time.RFC3339Nano, *u.CreatedAt)
						if e != nil {
							return changed()
						}
						createdAt = &t
					}
					var inserted string
					e := tx.QueryRow(ctx, `INSERT INTO operations_management_entries_v1(generation_id,operator_id,issuer,external_subject,username,first_name,last_name,email,email_verified,enabled,created_at,admission,required_actions)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING operator_id`, id, ID(issuer, u.ExternalSubject), issuer, u.ExternalSubject, u.Username, u.FirstName, u.LastName, u.Email, u.EmailVerified, u.Enabled, createdAt, u.Admission, u.RequiredActions).Scan(&inserted)
					if e == pgx.ErrNoRows {
						return changed()
					}
					if e != nil {
						return e
					}
					observed++
				}
				_, e := tx.Exec(ctx, `UPDATE operations_management_directory_v1 SET lease_until=$3 WHERE endpoint=$1 AND sync_id=$2`, s.Endpoint, id, s.now().Add(60*time.Second))
				return e
			})
			if e != nil {
				return e
			}
			if page.RawCount < 20 {
				break
			}
		}
		after, e := s.Reader.Count(ctx)
		if e != nil {
			return e
		}
		if after != before || raw != before {
			return changed()
		}
		return within(ctx, s.Pool, func(tx pgx.Tx) error {
			if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912460))`, s.Endpoint); e != nil {
				return e
			}
			var syncID string
			if e := tx.QueryRow(ctx, `SELECT sync_id FROM operations_management_directory_v1 WHERE endpoint=$1 FOR UPDATE`, s.Endpoint).Scan(&syncID); e != nil {
				return e
			}
			if syncID != id {
				return changed()
			}
			done := s.now()
			if _, e := tx.Exec(ctx, `UPDATE operations_management_generations_v1 SET state='complete',completed_at=$2,observed_count=$3,source_count_before=$4,source_count_after=$5 WHERE id=$1`, id, done, observed, before, after); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE operations_management_directory_v1 SET generation_id=$2,last_completed_at=$3,sync_id=NULL,lease_until=NULL,last_error=NULL WHERE endpoint=$1`, s.Endpoint, id, done); e != nil {
				return e
			}
			_, e := tx.Exec(ctx, `DELETE FROM operations_management_generations_v1 WHERE endpoint=$1 AND id<>$2`, s.Endpoint, id)
			return e
		})
	}()
	if e == nil {
		return Object{"state": "complete", "generationId": id, "observedCount": observed}, nil
	}
	code := safeCode(e)
	if e := within(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE operations_management_generations_v1 SET state='failed',code=$2 WHERE id=$1`, id, code); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE operations_management_directory_v1 SET sync_id=NULL,lease_until=NULL,last_error=$3 WHERE endpoint=$1 AND sync_id=$2`, s.Endpoint, id, code)
		return e
	}); e != nil {
		return nil, e
	}
	return Object{"state": "failed", "code": code}, nil
}
