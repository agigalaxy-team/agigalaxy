package registeredusers

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
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
	row, e := optionalObject(ctx, q, `SELECT to_jsonb(r) FROM (SELECT d.*,g.observed_count FROM operations_registered_directory_v1 d LEFT JOIN operations_registered_generations_v1 g ON g.id=d.generation_id WHERE d.endpoint=$1) r`, s.Endpoint)
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
	out := Object{"state": state, "coverage": "not-ready", "generationId": nil, "registeredAsOf": nil, "syncStartedAt": nil, "lastError": nil, "registeredCount": nil, "atomicSourceSnapshot": false}
	if matching {
		out["lastError"] = row["last_error"]
		out["syncStartedAt"] = nullableStamp(row["last_started_at"])
	}
	if ready {
		out["coverage"] = "complete-generation"
		out["generationId"] = row["generation_id"]
		out["registeredAsOf"] = nullableStamp(row["last_completed_at"])
		out["registeredCount"] = row["observed_count"]
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
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912451))`, s.Endpoint); e != nil {
			return e
		}
		old, e := optionalObject(ctx, tx, `SELECT to_jsonb(d) FROM operations_registered_directory_v1 d WHERE endpoint=$1 FOR UPDATE`, s.Endpoint)
		if e != nil {
			return e
		}
		lease, _ := time.Parse(time.RFC3339Nano, str(old["lease_until"]))
		if str(old["sync_id"]) != "" && lease.After(s.now()) {
			return nil
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_registered_directory_v1(endpoint,issuer,sync_id,lease_until,last_started_at) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(endpoint) DO UPDATE SET issuer=$2,generation_id=CASE WHEN operations_registered_directory_v1.issuer=$2 THEN operations_registered_directory_v1.generation_id ELSE NULL END,
   sync_id=$3,lease_until=$4,last_started_at=$5,last_error=NULL`, s.Endpoint, issuer, id, s.now().Add(60*time.Second), at)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_registered_generations_v1(id,endpoint,issuer,state,started_at) VALUES($1,$2,$3,'building',$4)`, id, s.Endpoint, issuer, at)
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
		for first := int64(0); ; first += 100 {
			if first > before+100 {
				return changed()
			}
			page, e := s.Reader.Page(ctx, first, 100)
			if e != nil {
				return e
			}
			raw += page.RawCount
			e = within(ctx, s.Pool, func(tx pgx.Tx) error {
				var syncID string
				if e := tx.QueryRow(ctx, `SELECT sync_id FROM operations_registered_directory_v1 WHERE endpoint=$1 FOR UPDATE`, s.Endpoint).Scan(&syncID); e != nil {
					return e
				}
				if syncID != id {
					return changed()
				}

				for _, u := range page.Items {
					var registeredAt any
					if u.RegisteredAt != nil {
						registeredAt = *u.RegisteredAt
					}
					var registrationID string
					if e := tx.QueryRow(ctx, `INSERT INTO operations_registered_subjects_v1(id,endpoint,issuer,external_subject) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint,issuer,external_subject) DO UPDATE SET external_subject=EXCLUDED.external_subject RETURNING id`, uuid.NewString(), s.Endpoint, issuer, u.ExternalSubject).Scan(&registrationID); e != nil {
						return e
					}
					accountService := s.Accounts
					if accountService == nil {
						accountService = &accounts.Service{Endpoint: s.Endpoint, Now: s.Now}
					}
					if _, e := accountService.ReserveWithin(ctx, tx, accounts.Identity{Issuer: issuer, ExternalSubject: u.ExternalSubject}); e != nil {
						return e
					}
					var inserted string
					e := tx.QueryRow(ctx, `INSERT INTO operations_registered_entries_v1(generation_id,registration_id,present,email,email_verified,enabled,registered_at,identity_display_name,observed_at) VALUES($1,$2,true,$3,$4,$5,$6::text::timestamptz,$7,$8) ON CONFLICT DO NOTHING RETURNING registration_id`, id, registrationID, u.Email, u.EmailVerified, u.Enabled, registeredAt, u.DisplayName, s.now()).Scan(&inserted)
					if e == pgx.ErrNoRows {
						return changed()
					}
					if e != nil {
						return e
					}
					observed++
				}
				_, e := tx.Exec(ctx, `UPDATE operations_registered_directory_v1 SET lease_until=$3 WHERE endpoint=$1 AND sync_id=$2`, s.Endpoint, id, s.now().Add(60*time.Second))
				return e
			})
			if e != nil {
				return e
			}
			if page.RawCount < 100 {
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
			if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912451))`, s.Endpoint); e != nil {
				return e
			}
			var syncID string
			if e := tx.QueryRow(ctx, `SELECT sync_id FROM operations_registered_directory_v1 WHERE endpoint=$1 FOR UPDATE`, s.Endpoint).Scan(&syncID); e != nil {
				return e
			}
			if syncID != id {
				return changed()
			}

			if _, e := tx.Exec(ctx, `INSERT INTO operations_registered_subjects_v1(id,endpoint,issuer,external_subject) SELECT a.id,a.endpoint,a.issuer,a.external_subject FROM community_accounts a WHERE a.endpoint=$1 ON CONFLICT(endpoint,issuer,external_subject) DO NOTHING`, s.Endpoint); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `INSERT INTO operations_registered_entries_v1(generation_id,registration_id,present,observed_at) SELECT $1,s.id,false,$3 FROM operations_registered_subjects_v1 s JOIN community_accounts a ON a.endpoint=s.endpoint AND a.issuer=s.issuer AND a.external_subject=s.external_subject WHERE s.endpoint=$2 ON CONFLICT DO NOTHING`, id, s.Endpoint, s.now()); e != nil {
				return e
			}
			done := s.now()
			if _, e := tx.Exec(ctx, `UPDATE operations_registered_generations_v1 SET state='complete',completed_at=$2,observed_count=$3,source_count_before=$4,source_count_after=$5 WHERE id=$1`, id, done, observed, before, after); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE operations_registered_directory_v1 SET generation_id=$2,last_completed_at=$3,sync_id=NULL,lease_until=NULL,last_error=NULL WHERE endpoint=$1`, s.Endpoint, id, done); e != nil {
				return e
			}
			_, e := tx.Exec(ctx, `DELETE FROM operations_registered_generations_v1 WHERE endpoint=$1 AND id<>$2`, s.Endpoint, id)
			return e
		})
	}()
	if e == nil {
		return Object{"state": "complete", "generationId": id, "observedCount": observed}, nil
	}
	code := safeDirectoryError(e)
	if e := within(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE operations_registered_generations_v1 SET state='failed',code=$2 WHERE id=$1`, id, code); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE operations_registered_directory_v1 SET sync_id=NULL,lease_until=NULL,last_error=$3 WHERE endpoint=$1 AND sync_id=$2`, s.Endpoint, id, code)
		return e
	}); e != nil {
		return nil, e
	}
	return Object{"state": "failed", "code": code}, nil
}
