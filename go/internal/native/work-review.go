package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/google/uuid"
)

type WorkReviewRequest struct {
	GalaxyID  string `json:"galaxyId,omitempty"`
	Host      string `json:"host"`
	SessionID string `json:"sessionId"`
	ReviewID  string `json:"reviewId,omitempty"`
	Reason    string `json:"reason,omitempty"`
}
type WorkReviewSummary struct {
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Outcome string `json:"outcome,omitempty"`
}
type WorkReviewApply struct {
	WorkReviewRequest
	Model       string                `json:"model,omitempty"`
	Summary     *WorkReviewSummary    `json:"summary,omitempty"`
	Experiences []WorkExperienceInput `json:"experiences,omitempty"`
}

func reviewError() error { return fault.New("local_work_review_conflict", 409) }
func validReviewRequest(x WorkReviewRequest) bool {
	return optionalID(x.GalaxyID) && validID(x.Host) && validID(x.SessionID)
}

func (s *Store) PrepareWorkReview(ctx context.Context, x WorkReviewRequest) (any, error) {
	if !validReviewRequest(x) {
		return nil, workInvalid()
	}
	var out any
	e := s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, owner string) error {
		if e := ensureWorkLearning(ctx, db); e != nil {
			return e
		}
		work, e := findWork(ctx, db, owner, WorkQuery{Host: x.Host, SessionID: x.SessionID})
		if e != nil {
			return e
		}
		if work == nil {
			out = map[string]any{"status": "empty"}
			return nil
		}
		id := text(work["id"])
		lease, e := oneMap(ctx, db, "SELECT * FROM work_review_lease WHERE work_id=?", id)
		if e != nil {
			return e
		}
		if lease != nil && integer(lease["expires_at"]) > time.Now().Unix() {
			out = map[string]any{"status": "busy"}
			return nil
		}
		cursor, e := oneMap(ctx, db, "SELECT through_sequence FROM work_review_cursor WHERE work_id=?", id)
		if e != nil {
			return e
		}
		summary, e := oneMap(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1", id)
		if e != nil {
			return e
		}
		after := max(integer(cursor["through_sequence"]), integer(summary["through_sequence"]))
		rows, e := rowsMaps(ctx, db, observationsSQL+" WHERE o.work_id=? AND o.sequence>? ORDER BY o.sequence LIMIT 100", id, after)
		if e != nil {
			return e
		}
		if len(rows) == 0 {
			out = map[string]any{"status": "empty"}
			return nil
		}
		revision := integer(summary["revision"])
		through := integer(rows[len(rows)-1]["sequence"])
		previous := any(nil)
		if summary != nil {
			previous = summaryView(summary)
		}
		observations := make([]any, 0, len(rows))
		for _, row := range rows {
			observations = append(observations, observationView(row))
		}
		var query strings.Builder
		if summary != nil {
			query.WriteString(truncateJS(text(summary["title"])+" "+text(summary["summary"]), 1000))
			query.WriteByte(' ')
		}
		for _, row := range rows {
			content := uploadObject(decoded(row["content_json"]))
			query.WriteString(truncateJS(text(content["excerpt"]), 300))
			query.WriteByte(' ')
			if query.Len() >= 6000 {
				break
			}
		}
		existing, e := searchExperienceWithin(ctx, db, owner, query.String(), "", 8, true)
		if e != nil {
			return e
		}
		// Only complete entries within the prompt budget may be revised by this
		// stateless reviewer. Index-only candidates are never silently truncated.
		const experienceBudget = 24000
		used := 0
		complete := make([]map[string]any, 0, len(existing))
		for i, item := range existing {
			candidate := uploadObject(item)
			encoded, e := json.Marshal(candidate)
			if e != nil {
				return e
			}
			if used+len(encoded) <= experienceBudget {
				used += len(encoded)
				candidate["complete"] = true
				complete = append(complete, candidate)
			} else {
				existing[i] = map[string]any{"id": candidate["id"], "revision": candidate["revision"], "title": candidate["title"], "sourceWorkIds": candidate["sourceWorkIds"], "complete": false}
			}
		}
		review := uuid.NewString()
		if lease != nil {
			if _, e = db.ExecContext(ctx, "DELETE FROM work_review_experience WHERE review_id=? AND owner_id=?", lease["review_id"], owner); e != nil {
				return e
			}
		}
		_, e = db.ExecContext(ctx, "INSERT OR REPLACE INTO work_review_lease(work_id,review_id,owner_id,after_sequence,through_sequence,expected_revision,expires_at) VALUES(?,?,?,?,?,?,?)", id, review, owner, after, through, revision, time.Now().Add(5*time.Minute).Unix())
		if e != nil {
			return e
		}
		for _, candidate := range complete {
			if _, e = db.ExecContext(ctx, "INSERT INTO work_review_experience(review_id,owner_id,experience_id,revision) VALUES(?,?,?,?)", review, owner, candidate["id"], candidate["revision"]); e != nil {
				return e
			}
		}
		out = map[string]any{"status": "ready", "reviewId": review, "galaxyId": owner, "workId": id, "afterSequence": after, "throughSequence": through, "targetSequence": integer(work["last_sequence"]), "hasMore": through < integer(work["last_sequence"]), "expectedRevision": revision, "observations": observations, "previousSummary": previous, "existingExperiences": existing}
		return nil
	})
	return out, e
}
func (s *Store) ReleaseWorkReview(ctx context.Context, x WorkReviewRequest) (any, error) {
	if !validReviewRequest(x) || !validID(x.ReviewID) || !isOne(x.Reason, "", "local_work_model_rate_limit", "local_work_model_authentication", "local_work_model_provider", "local_work_model_unavailable", "local_work_model_not_found", "local_work_model_unsupported", "local_work_model_invalid_request", "local_work_model_content_filter", "local_work_model_overloaded", "local_work_model_output_invalid", "local_work_model_interrupted", "local_work_model_failed") {
		return nil, workInvalid()
	}
	var out any
	e := s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, owner string) error {
		if e := ensureWorkLearning(ctx, db); e != nil {
			return e
		}
		work, e := findWork(ctx, db, owner, WorkQuery{Host: x.Host, SessionID: x.SessionID})
		if e != nil {
			return e
		}
		if work == nil {
			return reviewError()
		}
		if _, e = db.ExecContext(ctx, "DELETE FROM work_review_experience WHERE review_id=? AND owner_id=? AND review_id IN (SELECT review_id FROM work_review_lease WHERE work_id=? AND owner_id=?)", x.ReviewID, owner, work["id"], owner); e != nil {
			return e
		}
		res, e := db.ExecContext(ctx, "DELETE FROM work_review_lease WHERE work_id=? AND owner_id=? AND review_id=?", work["id"], owner, x.ReviewID)
		if e != nil {
			return e
		}
		n, e := res.RowsAffected()
		if e != nil {
			return e
		}
		if n == 1 && x.Reason != "" {
			_, e = db.ExecContext(ctx, "INSERT INTO work_summary_state(work_id,state,code,updated_at) VALUES(?,'pending',?,?) ON CONFLICT(work_id) DO UPDATE SET state='pending',code=excluded.code,updated_at=excluded.updated_at", work["id"], x.Reason, localNow())
			if e != nil {
				return e
			}
		}
		out = map[string]any{"released": n == 1}
		return nil
	})
	return out, e
}
func (s *Store) ApplyWorkReview(ctx context.Context, x WorkReviewApply) (any, error) {
	if !validReviewRequest(x.WorkReviewRequest) || !validID(x.ReviewID) || len(x.Experiences) > 20 || len(x.Model) > 256 {
		return nil, workInvalid()
	}
	safe, e := localdata.Redact(x)
	if e != nil {
		return nil, e
	}
	raw, e := localdata.Encode(safe.Value)
	if e != nil {
		return nil, e
	}
	if json.Unmarshal(raw, &x) != nil {
		return nil, workInvalid()
	}
	var out any
	e = s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, owner string) error {
		if e := ensureWorkLearning(ctx, db); e != nil {
			return e
		}
		work, e := findWork(ctx, db, owner, WorkQuery{Host: x.Host, SessionID: x.SessionID})
		if e != nil {
			return e
		}
		if work == nil {
			return reviewError()
		}
		id := text(work["id"])
		lease, e := oneMap(ctx, db, "SELECT * FROM work_review_lease WHERE work_id=? AND owner_id=? AND review_id=?", id, owner, x.ReviewID)
		if e != nil {
			return e
		}
		if lease == nil || integer(lease["expires_at"]) <= time.Now().Unix() {
			return reviewError()
		}
		cursor, e := oneMap(ctx, db, "SELECT through_sequence FROM work_review_cursor WHERE work_id=?", id)
		if e != nil {
			return e
		}
		if integer(cursor["through_sequence"]) > integer(lease["after_sequence"]) {
			return reviewError()
		}
		prev, e := oneMap(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1", id)
		if e != nil {
			return e
		}
		if integer(prev["revision"]) != integer(lease["expected_revision"]) {
			return reviewError()
		}
		through := integer(lease["through_sequence"])
		covered, e := rowsMaps(ctx, db, "SELECT id FROM work_observations WHERE work_id=? AND sequence>? AND sequence<=? ORDER BY sequence", id, integer(lease["after_sequence"]), through)
		if e != nil {
			return e
		}
		if len(covered) == 0 {
			return reviewError()
		}
		if x.Summary != nil {
			sum := x.Summary
			if sum.Title == "" || len(sum.Title) > 720 || sum.Summary == "" || len(sum.Summary) > 48000 {
				return workInvalid()
			}
			if sum.Outcome == "" {
				sum.Outcome = "unknown"
			}
			if !isOne(sum.Outcome, "unknown", "reported-success", "reported-failure", "partial", "cancelled") || through <= integer(prev["through_sequence"]) {
				return reviewError()
			}
			all, e := rowsMaps(ctx, db, "SELECT id FROM work_observations WHERE work_id=? AND sequence>? AND sequence<=? ORDER BY sequence", id, integer(prev["through_sequence"]), through)
			if e != nil {
				return e
			}
			sources := make([]string, 0, len(all))
			for _, r := range all {
				sources = append(sources, text(r["id"]))
			}
			_, e = db.ExecContext(ctx, "INSERT INTO work_summaries(work_id,revision,through_sequence,created_at,title,summary,outcome,model,sources_json,execution_json,exclusions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, integer(prev["revision"])+1, through, localNow(), sum.Title, sum.Summary, sum.Outcome, nullableText(x.Model), jsJSON(sources), jsJSON(map[string]any{"host": x.Host, "sessionId": x.SessionID}), jsJSON(safe.Exclusions))
			if e != nil {
				return e
			}
			state := "idle"
			if integer(work["last_sequence"]) > through {
				state = "pending"
			}
			_, e = db.ExecContext(ctx, "INSERT INTO work_summary_state(work_id,state,code,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,code=NULL,updated_at=excluded.updated_at", id, state, localNow())
			if e != nil {
				return e
			}
		}
		for _, item := range x.Experiences {
			if item.ID != "" {
				if item.ExpectedRevision == nil {
					return reviewError()
				}
				allowed, err := oneMap(ctx, db, "SELECT revision FROM work_review_experience WHERE review_id=? AND owner_id=? AND experience_id=?", x.ReviewID, owner, item.ID)
				if err != nil {
					return err
				}
				if allowed == nil || integer(allowed["revision"]) != *item.ExpectedRevision {
					return reviewError()
				}
			}
			if _, e = upsertExperienceWithin(ctx, db, owner, id, through, item); e != nil {
				return e
			}
		}
		_, e = db.ExecContext(ctx, "INSERT INTO work_review_cursor(work_id,through_sequence) VALUES(?,?) ON CONFLICT(work_id) DO UPDATE SET through_sequence=excluded.through_sequence", id, through)
		if e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "DELETE FROM work_review_experience WHERE review_id=? AND owner_id=?", x.ReviewID, owner); e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "DELETE FROM work_review_lease WHERE work_id=? AND review_id=?", id, x.ReviewID); e != nil {
			return e
		}
		out = map[string]any{"state": "applied", "workId": id, "throughSequence": through, "experienceCount": len(x.Experiences), "summarySaved": x.Summary != nil}
		return nil
	})
	return out, e
}
