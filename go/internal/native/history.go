package native

import (
	"context"
	"database/sql"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"path/filepath"
	"strconv"
)

type WorkQuery struct {
	GalaxyID      string `json:"galaxyId,omitempty"`
	Host          string `json:"host,omitempty"`
	SessionID     string `json:"sessionId,omitempty"`
	WorkID        string `json:"workId,omitempty"`
	Limit         int    `json:"limit,omitempty"`
	After         string `json:"after,omitempty"`
	AfterSequence int64  `json:"afterSequence,omitempty"`
}

func workLimit(q *WorkQuery, kind string) error {
	if q.Limit == 0 {
		if kind == "list" {
			q.Limit = 20
		} else {
			q.Limit = 100
		}
	}
	max := 200
	if kind == "list" {
		max = 100
	}
	if q.Limit < 1 || q.Limit > max || q.AfterSequence < 0 {
		return fault.New("local_work_input_invalid", 400)
	}
	for _, s := range []string{q.GalaxyID, q.WorkID, q.Host, q.SessionID} {
		if protocol.TextLength(s) > 512 {
			return fault.New("local_work_input_invalid", 400)
		}
	}
	if q.After != "" {
		n, e := strconv.ParseInt(q.After, 10, 64)
		if e != nil || n < 0 {
			return fault.New("local_work_input_invalid", 400)
		}
	}
	return nil
}
func (s *Store) history(ctx context.Context, owner string, run func(*sql.DB, string) error) error {
	return s.With(ctx, false, func(dir string) error {
		id, e := s.ownerWithin(dir, owner)
		if e != nil {
			return e
		}
		file := filepath.Join(dir, "work-history", "history.sqlite")
		present, e := exists(file)
		if e != nil {
			return e
		}
		if !present || id == "" {
			return run(nil, id)
		}
		db, e := openSQLite(file, false)
		if e != nil {
			return e
		}
		defer db.Close()
		return run(db, id)
	})
}
func (s *Store) WorkList(ctx context.Context, q WorkQuery) (any, error) {
	if e := workLimit(&q, "list"); e != nil {
		return nil, e
	}
	var out any
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		items := []any{}
		var next any
		if db != nil {
			var after any
			if q.After != "" {
				after, _ = strconv.ParseInt(q.After, 10, 64)
			}
			var host any
			if q.Host != "" {
				host = q.Host
			}
			rows, e := rowsMaps(ctx, db, "SELECT * FROM work_sessions WHERE owner_id=? AND (? IS NULL OR host=?) AND (? IS NULL OR last_sequence<?) ORDER BY last_sequence DESC LIMIT ?", owner, host, host, after, after, q.Limit+1)
			if e != nil {
				return e
			}
			if len(rows) > q.Limit {
				next = strconv.FormatInt(integer(rows[q.Limit-1]["last_sequence"]), 10)
				rows = rows[:q.Limit]
			}
			for _, row := range rows {
				v, e := workView(ctx, db, row)
				if e != nil {
					return e
				}
				items = append(items, v)
			}
		}
		var id any
		if owner != "" {
			id = owner
		}
		out = map[string]any{"galaxyId": id, "items": items, "nextAfter": next}
		return nil
	})
	return out, e
}
func findWork(ctx context.Context, db *sql.DB, owner string, q WorkQuery) (map[string]any, error) {
	if db == nil {
		return nil, nil
	}
	if q.WorkID != "" {
		return oneMap(ctx, db, "SELECT * FROM work_sessions WHERE owner_id=? AND id=?", owner, q.WorkID)
	}
	return oneMap(ctx, db, "SELECT * FROM work_sessions WHERE owner_id=? AND host=? AND session_id=?", owner, q.Host, q.SessionID)
}

const observationsSQL = "SELECT o.*,(SELECT MAX(n.revision) FROM work_observations n WHERE n.work_id=o.work_id AND n.source_id=o.source_id) AS latest_revision FROM work_observations o"

func observationView(r map[string]any) any {
	return map[string]any{"id": r["id"], "sequence": r["sequence"], "sourceId": r["source_id"], "revision": r["revision"], "kind": r["kind"], "latestRevision": r["latest_revision"], "superseded": integer(r["revision"]) < integer(r["latest_revision"]), "occurredAt": r["occurred_at"], "observedAt": r["observed_at"], "source": decoded(r["source_json"]), "content": decoded(r["content_json"]), "details": decoded(r["details_json"]), "exclusions": array(r["exclusions_json"]), "environmentId": r["environment_id"], "environmentMeaning": "observed-at-collection", "localOnly": true}
}
func workView(ctx context.Context, db *sql.DB, r map[string]any) (any, error) {
	summary, e := oneMap(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1", r["id"])
	if e != nil {
		return nil, e
	}
	environment, e := oneMap(ctx, db, "SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version DESC LIMIT 1", r["owner_id"], r["host"], r["session_id"])
	if e != nil {
		return nil, e
	}
	processing, e := oneMap(ctx, db, "SELECT state,code,updated_at AS updatedAt FROM work_summary_state WHERE work_id=?", r["id"])
	if e != nil {
		return nil, e
	}
	if processing == nil {
		processing = map[string]any{"state": "pending", "code": nil}
	}
	var env any
	if environment != nil {
		env = map[string]any{"id": environment["id"], "version": environment["version"], "observedAt": environment["observed_at"]}
	}
	title := text(summary["title"])
	if title == "" {
		title = text(r["title"])
	}
	if title == "" {
		title = "Recorded work"
	}
	outcome := text(summary["outcome"])
	if outcome == "" {
		outcome = "unknown"
	}
	source := "host-observations"
	if summary != nil {
		source = "user-model"
	}
	return map[string]any{"workId": r["id"], "galaxyId": r["owner_id"], "host": r["host"], "sessionId": r["session_id"], "title": title, "summary": text(summary["summary"]), "outcome": outcome, "summaryRevision": integer(summary["revision"]), "lastSequence": r["last_sequence"], "startedAt": r["started_at"], "updatedAt": r["updated_at"], "exclusions": array(summary["exclusions_json"]), "processing": processing, "pending": integer(r["last_sequence"]) > integer(summary["through_sequence"]), "environmentVersion": env, "sourceKind": source, "localOnly": true}, nil
}
func (s *Store) WorkGet(ctx context.Context, q WorkQuery) (any, error) {
	if e := workLimit(&q, "get"); e != nil {
		return nil, e
	}
	if q.WorkID == "" && (q.Host == "" || q.SessionID == "") {
		return nil, fault.New("local_work_input_invalid", 400)
	}
	var out any
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		work, e := findWork(ctx, db, owner, q)
		if e != nil || work == nil {
			return e
		}
		view, e := workView(ctx, db, work)
		if e != nil {
			return e
		}
		rows, e := rowsMaps(ctx, db, observationsSQL+" WHERE o.work_id=? AND o.sequence>? ORDER BY o.sequence LIMIT ?", work["id"], q.AfterSequence, q.Limit+1)
		if e != nil {
			return e
		}
		var next any
		if len(rows) > q.Limit {
			next = rows[q.Limit-1]["sequence"]
			rows = rows[:q.Limit]
		}
		observations := []any{}
		for _, r := range rows {
			observations = append(observations, observationView(r))
		}
		sr, e := rowsMaps(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 20", work["id"])
		if e != nil {
			return e
		}
		summaries := []any{}
		for _, r := range sr {
			summaries = append(summaries, map[string]any{"revision": r["revision"], "throughSequence": r["through_sequence"], "title": r["title"], "summary": r["summary"], "outcome": r["outcome"], "model": r["model"], "execution": decoded(r["execution_json"]), "exclusions": array(r["exclusions_json"]), "createdAt": r["created_at"], "sourceKind": "user-model", "sourceObservationIds": decoded(r["sources_json"])})
		}
		er, e := rowsMaps(ctx, db, "SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version", owner, work["host"], work["session_id"])
		if e != nil {
			return e
		}
		environments := []any{}
		for _, r := range er {
			environments = append(environments, map[string]any{"id": r["id"], "version": r["version"], "observedAt": r["observed_at"], "facts": decoded(r["facts_json"]), "exclusions": array(r["exclusions_json"])})
		}
		out = map[string]any{"work": view, "observations": observations, "nextAfter": next, "summaries": summaries, "environments": environments}
		return nil
	})
	return out, e
}
