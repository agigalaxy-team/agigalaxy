package discovery

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type LegacyEnqueuer interface {
	EnqueueWithin(context.Context, pgx.Tx, jobs.Task, time.Time) (string, error)
	SupersedeSearchRecoveryWithin(context.Context, pgx.Tx, string, string, int64) (int64, error)
}
type ConsentReader func(context.Context, pgx.Tx, deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error)

// LegacyIndex is the original bounded public-candidate cache. Its documents
// confer no source read right; every API result must still use its owning reader.
type LegacyIndex struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Now           func() time.Time
	MaxAgeSeconds int64
	Devices       *deviceauth.Service
	ConsentReader ConsentReader
	Evidence      *evidence.Service
	Jobs          LegacyEnqueuer
}

func (s *LegacyIndex) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (s *LegacyIndex) maxAge() (int64, error) {
	u, e := url.Parse(s.Endpoint)
	if e != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || u.String() != s.Endpoint {
		return 0, errors.New("invalid search index configuration")
	}
	origin := normalizedOrigin(u)
	if u.Scheme == "ws" && u.Port() == "80" || u.Scheme == "wss" && u.Port() == "443" || u.Scheme == "ftp" && u.Port() == "21" {
		origin = strings.TrimSuffix(origin, ":"+u.Port())
	}
	if origin != s.Endpoint || !(u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "ws" || u.Scheme == "wss" || u.Scheme == "ftp") {
		return 0, errors.New("invalid search index configuration")
	}
	age := s.MaxAgeSeconds
	if age == 0 {
		age = 60
	}
	if age < 1 || age > 60 {
		return 0, errors.New("invalid search index configuration")
	}
	return age, nil
}

const legacySources = `SELECT 'case' AS type,id,subject_id FROM cases UNION ALL SELECT 'history',id,subject_id FROM cases UNION ALL SELECT 'proof',id,subject_id FROM proofs UNION ALL SELECT 'capsule',id,subject_id FROM capsules UNION ALL SELECT type,id,owner_id FROM builders WHERE type IN ('worker','hub')`

func (s *LegacyIndex) Configure(ctx context.Context, enabled, rebuild bool) (Object, error) {
	if _, e := s.maxAge(); e != nil {
		return nil, e
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	previous, e := rowObject(ctx, tx, "SELECT to_jsonb(c) FROM search_index_control c WHERE singleton FOR UPDATE")
	if e != nil {
		return nil, e
	}
	if previous != nil && str(previous, "endpoint") != s.Endpoint {
		return nil, errors.New("search index endpoint changed")
	}
	rebuild = rebuild || enabled && previous["enabled"] != true
	if previous == nil {
		_, e = tx.Exec(ctx, "INSERT INTO search_index_control(endpoint,enabled) VALUES($1,$2)", s.Endpoint, enabled)
	} else {
		_, e = tx.Exec(ctx, "UPDATE search_index_control SET enabled=$1,scan_type=CASE WHEN $2 THEN '' ELSE scan_type END,scan_after=CASE WHEN $2 THEN NULL ELSE scan_after END,scan_complete=CASE WHEN $2 THEN false ELSE scan_complete END,updated_at=$3", enabled, rebuild, s.now())
	}
	if e != nil {
		return nil, e
	}
	if !enabled {
		if _, e = tx.Exec(ctx, "DELETE FROM search_documents"); e != nil {
			return nil, e
		}
	}
	return Object{"enabled": enabled, "rebuilding": enabled && (previous == nil || rebuild || previous["scan_complete"] != true)}, tx.Commit(ctx)
}
func (s *LegacyIndex) SeedBatch(ctx context.Context, limit int) (Object, error) {
	if limit < 1 || limit > 100 {
		return nil, errors.New("invalid index seed batch")
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	state, e := rowObject(ctx, tx, "SELECT to_jsonb(c) FROM search_index_control c WHERE singleton FOR UPDATE")
	if e != nil {
		return nil, e
	}
	if state == nil || state["enabled"] != true || str(state, "endpoint") != s.Endpoint || state["scan_complete"] == true {
		return Object{"queued": 0, "complete": state["scan_complete"] == true}, nil
	}
	rows, e := tx.Query(ctx, "SELECT type,id::text,subject_id FROM ("+legacySources+") s WHERE type>$1 OR type=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY type,id LIMIT $3", state["scan_type"], state["scan_after"], limit)
	if e != nil {
		return nil, e
	}
	type item struct{ kind, id, subject string }
	found := []item{}
	for rows.Next() {
		var r item
		if e = rows.Scan(&r.kind, &r.id, &r.subject); e != nil {
			rows.Close()
			return nil, e
		}
		found = append(found, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	lastType, lastID := state["scan_type"], state["scan_after"]
	for _, row := range found {
		if _, e = tx.Exec(ctx, "SELECT public.galaxy_queue_search_source($1,$2,$3)", row.kind, row.id, row.subject); e != nil {
			return nil, e
		}
		lastType = row.kind
		lastID = row.id
	}
	if _, e = tx.Exec(ctx, "UPDATE search_index_control SET scan_type=$1,scan_after=$2,scan_complete=$3,updated_at=$4", lastType, lastID, len(found) < limit, s.now()); e != nil {
		return nil, e
	}
	return Object{"queued": len(found), "complete": len(found) < limit}, tx.Commit(ctx)
}
func (s *LegacyIndex) RefreshExpired(ctx context.Context) (Object, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	rows, e := tx.Query(ctx, "SELECT source_type,source_id::text,subject_id FROM search_documents WHERE valid_until<=$1 ORDER BY valid_until,source_type,source_id LIMIT 100", s.now())
	if e != nil {
		return nil, e
	}
	type source struct{ kind, id, subject string }
	sources := []source{}
	for rows.Next() {
		var r source
		if e = rows.Scan(&r.kind, &r.id, &r.subject); e != nil {
			rows.Close()
			return nil, e
		}
		sources = append(sources, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for _, r := range sources {
		if _, e = tx.Exec(ctx, "SELECT public.galaxy_queue_search_source($1,$2,$3)", r.kind, r.id, r.subject); e != nil {
			return nil, e
		}
	}
	return Object{"queued": len(sources)}, tx.Commit(ctx)
}

type LegacyIndexJob struct {
	ID, LeaseID string
	Attempts    int
	Payload     Object
}
type LegacyDocument struct {
	Type, ID, SubjectID, Title, Summary, SearchText, Version string
	Metadata                                                 Object
	Dependencies                                             []string
	ValidUntil                                               int64
}
type LegacyProcessOptions struct {
	AfterClaim   func(context.Context, LegacyIndexJob) error
	BeforeCommit func(context.Context, LegacyIndexJob, *LegacyDocument) error
}

func (s *LegacyIndex) claim(ctx context.Context) (*LegacyIndexJob, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	var enabled bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1)", s.Endpoint).Scan(&enabled); e != nil {
		return nil, e
	}
	if !enabled {
		return nil, nil
	}
	if _, e = tx.Exec(ctx, `UPDATE jobs SET state='failed',lease_id=NULL,locked_until=NULL WHERE id IN (SELECT id FROM jobs WHERE kind='search-index' AND attempts>=5 AND (state='pending' OR state='running' AND locked_until<=$1) ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)`, s.now()); e != nil {
		return nil, e
	}
	job := LegacyIndexJob{}
	var payload []byte
	e = tx.QueryRow(ctx, `SELECT id::text,attempts,payload FROM jobs WHERE kind='search-index' AND attempts<5 AND (state='pending' AND available_at<=$1 OR state='running' AND locked_until<=$1) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, s.now()).Scan(&job.ID, &job.Attempts, &payload)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if e = decode(payload, &job.Payload); e != nil {
		return nil, e
	}
	job.LeaseID = uuid.NewString()
	job.Attempts++
	if _, e = tx.Exec(ctx, "UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3 WHERE id=$1", job.ID, job.LeaseID, s.now().Add(30*time.Second)); e != nil {
		return nil, e
	}
	return &job, tx.Commit(ctx)
}
func hiddenLegacySource(e error) bool {
	var known *fault.Error
	if !errors.As(e, &known) {
		return false
	}
	switch known.Status {
	case 401, 403, 404, 409, 410, 422:
		return true
	}
	return false
}
func (s *LegacyIndex) ProcessNext(ctx context.Context, options LegacyProcessOptions) (Object, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	job, e := s.claim(ctx)
	if e != nil {
		return nil, e
	}
	if job == nil {
		return Object{"processed": false}, nil
	}
	if options.AfterClaim != nil {
		if e = options.AfterClaim(ctx, *job); e != nil {
			return nil, e
		}
	}
	result, e := s.processClaim(ctx, *job, options)
	if e == nil {
		return result, nil
	}
	state := "failed"
	if job.Attempts < 5 {
		state = "pending"
	}
	delay := min(300, 10*(1<<min(job.Attempts, 10)))
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, update := s.Pool.Exec(settle, `UPDATE jobs SET state=$3,lease_id=NULL,locked_until=NULL,available_at=$4 WHERE id=$1 AND lease_id=$2 AND kind='search-index' AND state='running'`, job.ID, job.LeaseID, state, s.now().Add(time.Duration(delay)*time.Second)); update != nil {
		return nil, update
	}
	return Object{"processed": true, "state": state, "interrupted": ctx.Err() != nil}, nil
}
func (s *LegacyIndex) processClaim(ctx context.Context, job LegacyIndexJob, options LegacyProcessOptions) (Object, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	document, e := s.build(ctx, tx, job)
	if e != nil && !hiddenLegacySource(e) {
		return nil, e
	}
	if options.BeforeCommit != nil {
		if e = options.BeforeCommit(ctx, job, document); e != nil {
			return nil, e
		}
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	var state string
	var lease *string
	var until *time.Time
	e = tx.QueryRow(ctx, "SELECT state,lease_id::text,locked_until FROM jobs WHERE id=$1 AND kind='search-index' FOR UPDATE", job.ID).Scan(&state, &lease, &until)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && (state != "running" || lease == nil || *lease != job.LeaseID || until == nil || !until.After(s.now())) {
		return Object{"processed": false, "leaseLost": true}, nil
	}
	if e != nil {
		return nil, e
	}
	var enabled bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM search_index_control WHERE enabled AND endpoint=$1)", s.Endpoint).Scan(&enabled); e != nil {
		return nil, e
	}
	if !enabled {
		return Object{"processed": false, "disabled": true}, nil
	}
	if _, e = tx.Exec(ctx, "DELETE FROM search_documents WHERE source_type=$1 AND source_id=$2", job.Payload["sourceType"], job.Payload["sourceId"]); e != nil {
		return nil, e
	}
	if document != nil {
		if _, e = tx.Exec(ctx, `INSERT INTO search_documents(source_type,source_id,subject_id,endpoint,title,summary,search_text,source_version,metadata,dependencies,generation,built_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`, document.Type, document.ID, document.SubjectID, s.Endpoint, document.Title, document.Summary, document.SearchText, document.Version, jsonString(document.Metadata), jsonString(document.Dependencies), job.Payload["generation"], s.now(), time.Unix(document.ValidUntil, 0)); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, "UPDATE jobs SET state='completed',lease_id=NULL,locked_until=NULL WHERE id=$1", job.ID); e != nil {
		return nil, e
	}
	result := "hidden"
	if document != nil {
		result = "indexed"
	}
	return Object{"processed": true, "state": result, "sourceType": job.Payload["sourceType"]}, tx.Commit(ctx)
}
