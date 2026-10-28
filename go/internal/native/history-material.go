package native

import (
	"context"
	"database/sql"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func summaryView(r map[string]any) any {
	return map[string]any{"revision": r["revision"], "throughSequence": r["through_sequence"], "title": r["title"], "summary": r["summary"], "outcome": r["outcome"], "model": r["model"], "execution": decoded(r["execution_json"]), "exclusions": array(r["exclusions_json"]), "createdAt": r["created_at"], "sourceKind": "user-model", "sourceObservationIds": decoded(r["sources_json"])}
}
func environmentView(r map[string]any) any {
	return map[string]any{"id": r["id"], "version": r["version"], "observedAt": r["observed_at"], "facts": decoded(r["facts_json"]), "exclusions": array(r["exclusions_json"])}
}
func (s *Store) WorkPending(ctx context.Context, q WorkQuery) (any, error) {
	if e := workLimit(&q, "pending"); e != nil {
		return nil, e
	}
	if q.WorkID == "" {
		return nil, fault.New("local_work_input_invalid", 400)
	}
	var out any
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		work, e := findWork(ctx, db, owner, q)
		if e != nil {
			return e
		}
		if work == nil {
			return fault.New("local_work_unavailable", 409)
		}
		summary, e := oneMap(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1", work["id"])
		if e != nil {
			return e
		}
		after := integer(summary["through_sequence"])
		rows, e := rowsMaps(ctx, db, observationsSQL+" WHERE o.work_id=? AND o.sequence>? ORDER BY o.sequence LIMIT ?", work["id"], after, q.Limit+1)
		if e != nil {
			return e
		}
		hasMore := len(rows) > q.Limit
		if hasMore {
			rows = rows[:q.Limit]
		}
		observations, environments := []any{}, []any{}
		seen := map[string]bool{}
		through := after
		for _, r := range rows {
			observations = append(observations, observationView(r))
			through = integer(r["sequence"])
			id := text(r["environment_id"])
			if id != "" && !seen[id] {
				seen[id] = true
				environment, e := oneMap(ctx, db, "SELECT * FROM work_environments WHERE owner_id=? AND id=?", owner, id)
				if e != nil {
					return e
				}
				if environment != nil {
					environments = append(environments, environmentView(environment))
				}
			}
		}
		processing, e := oneMap(ctx, db, "SELECT state,code,updated_at AS updatedAt FROM work_summary_state WHERE work_id=?", work["id"])
		if e != nil {
			return e
		}
		if processing == nil {
			processing = map[string]any{"state": "pending", "code": nil}
		}
		var previous any
		if summary != nil {
			previous = map[string]any{"title": summary["title"], "summary": summary["summary"], "outcome": summary["outcome"], "exclusions": array(summary["exclusions_json"])}
		}
		out = map[string]any{"galaxyId": owner, "workId": work["id"], "expectedRevision": integer(summary["revision"]), "afterSequence": after, "throughSequence": through, "observations": observations, "environments": environments, "hasMore": hasMore, "processing": processing, "previousSummary": previous}
		return nil
	})
	return out, e
}
func (s *Store) WorkExport(ctx context.Context, q WorkQuery) (any, error) {
	if e := workLimit(&q, "get"); e != nil {
		return nil, e
	}
	if q.WorkID == "" {
		return nil, fault.New("local_work_input_invalid", 400)
	}
	var out any
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		work, e := findWork(ctx, db, owner, q)
		if e != nil {
			return e
		}
		if work == nil {
			return fault.New("local_work_unavailable", 409)
		}
		view, e := workView(ctx, db, work)
		if e != nil {
			return e
		}
		rows, e := rowsMaps(ctx, db, observationsSQL+" WHERE o.work_id=? ORDER BY o.sequence", work["id"])
		if e != nil {
			return e
		}
		observations := []any{}
		for _, r := range rows {
			observations = append(observations, observationView(r))
		}
		rows, e = rowsMaps(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision", work["id"])
		if e != nil {
			return e
		}
		summaries := []any{}
		for _, r := range rows {
			summaries = append(summaries, summaryView(r))
		}
		rows, e = rowsMaps(ctx, db, "SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version", owner, work["host"], work["session_id"])
		if e != nil {
			return e
		}
		environments := []any{}
		for _, r := range rows {
			environments = append(environments, environmentView(r))
		}
		out = map[string]any{"format": "galaxy-local-work-v1", "exportedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "work": view, "observations": observations, "summaries": summaries, "environments": environments, "materialScope": "retained-observations-and-summaries", "completeConversation": false, "localOnly": true}
		return nil
	})
	return out, e
}
