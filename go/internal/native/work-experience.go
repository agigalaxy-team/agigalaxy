package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type WorkExperienceInput struct {
	ID               string `json:"id,omitempty"`
	ExpectedRevision *int64 `json:"expectedRevision,omitempty"`
	Title            string `json:"title"`
	Conditions       string `json:"conditions"`
	Method           string `json:"method"`
	Limitations      string `json:"limitations,omitempty"`
	Outcome          string `json:"outcome,omitempty"`
	WorkID           string `json:"workId,omitempty"`
	GalaxyID         string `json:"galaxyId,omitempty"`
}
type WorkExperienceQuery struct {
	GalaxyID   string `json:"galaxyId,omitempty"`
	Query      string `json:"query,omitempty"`
	Conditions string `json:"conditions,omitempty"`
	ID         string `json:"id,omitempty"`
	Limit      int    `json:"limit,omitempty"`
}

func experienceView(row map[string]any, full bool) map[string]any {
	v := map[string]any{"id": row["id"], "revision": row["revision"], "title": row["title"], "conditions": row["conditions"], "limitations": row["limitations"], "outcome": row["outcome"], "sourceWorkId": row["source_work_id"], "throughSequence": row["through_sequence"], "updatedAt": row["updated_at"]}
	if full {
		v["method"] = row["method"]
	}
	return v
}
func experienceViewWithin(ctx context.Context, db *sql.DB, row map[string]any, full bool) (map[string]any, error) {
	value := experienceView(row, full)
	refs, err := rowsMaps(ctx, db, "SELECT work_id FROM work_experience_sources WHERE owner_id=? AND id=? AND revision=? ORDER BY work_id", row["owner_id"], row["id"], row["revision"])
	if err != nil {
		return nil, err
	}
	sources := make([]string, 0, len(refs))
	for _, ref := range refs {
		sources = append(sources, text(ref["work_id"]))
	}
	value["sourceWorkIds"] = sources
	return value, nil
}
func upsertExperienceWithin(ctx context.Context, db *sql.DB, owner, workID string, through int64, x WorkExperienceInput) (any, error) {
	if !optionalID(x.ID) || x.Title == "" || len(x.Title) > 720 || x.Conditions == "" || len(x.Conditions) > 16000 || x.Method == "" || len(x.Method) > 32000 || len(x.Limitations) > 16000 || len(x.Outcome) > 1000 {
		return nil, workInvalid()
	}
	id := x.ID
	revision := int64(1)
	if id == "" {
		if x.ExpectedRevision != nil {
			return nil, workInvalid()
		}
		id = uuid.NewString()
	} else {
		if x.ExpectedRevision == nil {
			return nil, workInvalid()
		}
		row, e := oneMap(ctx, db, "SELECT revision FROM work_experience WHERE id=? AND owner_id=? AND id NOT IN (SELECT id FROM work_experience_retired WHERE owner_id=?)", id, owner, owner)
		if e != nil {
			return nil, e
		}
		if row == nil || integer(row["revision"]) != *x.ExpectedRevision {
			return nil, fault.New("local_experience_revision_conflict", 409)
		}
		revision = integer(row["revision"]) + 1
	}
	now := localNow()
	value := map[string]any{"id": id, "revision": revision, "title": x.Title, "conditions": x.Conditions, "method": x.Method, "limitations": x.Limitations, "outcome": x.Outcome, "sourceWorkId": workID, "throughSequence": through, "updatedAt": now}
	_, e := db.ExecContext(ctx, "INSERT INTO work_experience(id,owner_id,revision,title,conditions,method,limitations,outcome,source_work_id,through_sequence,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,title=excluded.title,conditions=excluded.conditions,method=excluded.method,limitations=excluded.limitations,outcome=excluded.outcome,source_work_id=excluded.source_work_id,through_sequence=excluded.through_sequence,updated_at=excluded.updated_at", id, owner, revision, x.Title, x.Conditions, x.Method, x.Limitations, x.Outcome, workID, through, now)
	if e != nil {
		return nil, e
	}
	if _, e = db.ExecContext(ctx, "INSERT INTO work_experience_revision(id,revision,owner_id,source_work_id,through_sequence,value_json,created_at) VALUES(?,?,?,?,?,?,?)", id, revision, owner, workID, through, jsJSON(value), now); e != nil {
		return nil, e
	}
	if revision > 1 {
		if _, e = db.ExecContext(ctx, "INSERT INTO work_experience_sources(id,revision,owner_id,work_id) SELECT id,?,owner_id,work_id FROM work_experience_sources WHERE id=? AND owner_id=? AND revision=?", revision, id, owner, revision-1); e != nil {
			return nil, e
		}
	}
	if _, e = db.ExecContext(ctx, "INSERT OR IGNORE INTO work_experience_sources(id,revision,owner_id,work_id) VALUES(?,?,?,?)", id, revision, owner, workID); e != nil {
		return nil, e
	}
	if _, e = db.ExecContext(ctx, "DELETE FROM work_experience_search WHERE id=? AND owner_id=?", id, owner); e != nil {
		return nil, e
	}
	if _, e = db.ExecContext(ctx, "INSERT INTO work_experience_search(id,owner_id,title,conditions,method,limitations) VALUES(?,?,?,?,?,?)", id, owner, x.Title, x.Conditions, x.Method, x.Limitations); e != nil {
		return nil, e
	}
	refs, e := rowsMaps(ctx, db, "SELECT work_id FROM work_experience_sources WHERE owner_id=? AND id=? AND revision=? ORDER BY work_id", owner, id, revision)
	if e != nil {
		return nil, e
	}
	sourceIDs := make([]string, 0, len(refs))
	for _, ref := range refs {
		sourceIDs = append(sourceIDs, text(ref["work_id"]))
	}
	value["sourceWorkIds"] = sourceIDs
	return value, nil
}
func (s *Store) UpsertWorkExperience(ctx context.Context, x WorkExperienceInput) (any, error) {
	if !validID(x.WorkID) || !optionalID(x.GalaxyID) {
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
		work, e := findWork(ctx, db, owner, WorkQuery{WorkID: x.WorkID})
		if e != nil {
			return e
		}
		if work == nil || integer(work["last_sequence"]) == 0 {
			return fault.New("local_work_unavailable", 404)
		}
		out, e = upsertExperienceWithin(ctx, db, owner, x.WorkID, integer(work["last_sequence"]), x)
		return e
	})
	return out, e
}
func experienceTerms(query string) (indexed, short []string) {
	r := []rune(strings.ToLower(query))
	seen := map[string]bool{}
	add := func(v string) {
		if v == "" || seen[v] || len(indexed)+len(short) >= 32 {
			return
		}
		seen[v] = true
		if len([]rune(v)) >= 3 {
			indexed = append(indexed, v)
		} else {
			short = append(short, v)
		}
	}
	for i := 0; i < len(r) && len(indexed)+len(short) < 32; {
		if !unicode.IsLetter(r[i]) && !unicode.IsDigit(r[i]) {
			i++
			continue
		}
		han := unicode.Is(unicode.Han, r[i])
		j := i + 1
		for j < len(r) && (unicode.IsLetter(r[j]) || unicode.IsDigit(r[j])) && unicode.Is(unicode.Han, r[j]) == han {
			j++
		}
		part := r[i:j]
		if han && len(part) >= 3 {
			for k := 0; k+3 <= len(part) && len(indexed)+len(short) < 32; k++ {
				add(string(part[k : k+3]))
			}
		} else {
			add(string(part))
		}
		i = j
	}
	return indexed, short
}
func searchExperienceWithin(ctx context.Context, db *sql.DB, owner, query, conditions string, limit int, includeMethod bool) ([]any, error) {
	indexed, short := experienceTerms(query)
	if len(indexed) == 0 && len(short) == 0 {
		return []any{}, nil
	}
	sqlText := "SELECT e.* FROM work_experience_search JOIN work_experience e ON e.id=work_experience_search.id AND e.owner_id=work_experience_search.owner_id WHERE e.owner_id=?"
	args := []any{owner}
	if len(indexed) > 0 {
		quoted := make([]string, 0, len(indexed))
		for _, term := range indexed {
			quoted = append(quoted, "\""+strings.ReplaceAll(term, "\"", "\"\"")+"\"")
		}
		sqlText += " AND work_experience_search MATCH ?"
		args = append(args, strings.Join(quoted, " OR "))
	} else {
		// FTS5 trigram cannot index one- or two-character searches. Only this
		// bounded-result fallback uses LIKE and may scan the current owner's index.
		clauses := make([]string, 0, len(short))
		for _, term := range short {
			clauses = append(clauses, "(work_experience_search.title LIKE ? OR work_experience_search.conditions LIKE ? OR work_experience_search.method LIKE ? OR work_experience_search.limitations LIKE ?)")
			for i := 0; i < 4; i++ {
				args = append(args, "%"+term+"%")
			}
		}
		sqlText += " AND (" + strings.Join(clauses, " OR ") + ")"
	}
	if conditions != "" {
		sqlText += " AND instr(e.conditions, ?) > 0"
		args = append(args, conditions)
	}
	if len(indexed) > 0 {
		sqlText += " ORDER BY bm25(work_experience_search,0,0,6,4,2,1),e.updated_at DESC LIMIT ?"
	} else {
		sqlText += " ORDER BY e.updated_at DESC LIMIT ?"
	}
	args = append(args, limit)
	rows, e := rowsMaps(ctx, db, sqlText, args...)
	if e != nil {
		return nil, e
	}
	items := make([]any, 0, len(rows))
	for _, row := range rows {
		value, e := experienceViewWithin(ctx, db, row, includeMethod)
		if e != nil {
			return nil, e
		}
		items = append(items, value)
	}
	return items, nil
}
func (s *Store) SearchWorkExperience(ctx context.Context, q WorkExperienceQuery) (any, error) {
	if !optionalID(q.GalaxyID) || strings.TrimSpace(q.Query) == "" || protocol.TextLength(q.Query) > 2000 || protocol.TextLength(q.Conditions) > 2000 || q.Limit < 0 || q.Limit > 50 {
		return nil, workInvalid()
	}
	if q.Limit == 0 {
		q.Limit = 10
	}
	out := map[string]any{"items": []any{}}
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		if db == nil || owner == "" {
			return nil
		}
		table, e := oneMap(ctx, db, "SELECT name FROM sqlite_schema WHERE name='work_experience_search'")
		if e != nil || table == nil {
			return e
		}
		items, e := searchExperienceWithin(ctx, db, owner, q.Query, q.Conditions, q.Limit, false)
		if e != nil {
			return e
		}
		out["items"] = items
		out["galaxyId"] = owner
		return nil
	})
	return out, e
}
func (s *Store) GetWorkExperience(ctx context.Context, q WorkExperienceQuery) (any, error) {
	if !optionalID(q.GalaxyID) || !validID(q.ID) {
		return nil, workInvalid()
	}
	var out any
	e := s.history(ctx, q.GalaxyID, func(db *sql.DB, owner string) error {
		if db == nil {
			return fault.New("local_experience_unavailable", 404)
		}
		table, e := oneMap(ctx, db, "SELECT name FROM sqlite_schema WHERE name='work_experience'")
		if e != nil {
			return e
		}
		if table == nil {
			return fault.New("local_experience_unavailable", 404)
		}
		row, e := oneMap(ctx, db, "SELECT * FROM work_experience WHERE owner_id=? AND id=?", owner, q.ID)
		if e != nil {
			return e
		}
		if row == nil {
			return fault.New("local_experience_unavailable", 404)
		}
		retired, e := oneMap(ctx, db, "SELECT id FROM work_experience_retired WHERE id=? AND owner_id=?", q.ID, owner)
		if e != nil {
			return e
		}
		if retired != nil {
			versions, e := rowsMaps(ctx, db, "SELECT value_json,revision,owner_id,id FROM work_experience_revision WHERE id=? AND owner_id=? ORDER BY revision DESC", q.ID, owner)
			if e != nil {
				return e
			}
			items := make([]any, 0, len(versions))
			for _, v := range versions {
				value := uploadObject(decoded(v["value_json"]))
				refs, e := rowsMaps(ctx, db, "SELECT work_id FROM work_experience_sources WHERE owner_id=? AND id=? AND revision=? ORDER BY work_id", owner, q.ID, v["revision"])
				if e != nil {
					return e
				}
				sources := make([]string, 0, len(refs))
				for _, ref := range refs {
					sources = append(sources, text(ref["work_id"]))
				}
				value["sourceWorkIds"] = sources
				items = append(items, value)
			}
			out = map[string]any{"id": q.ID, "state": "retired", "versions": items}
			return nil
		}
		out, e = experienceViewWithin(ctx, db, row, true)
		return e
	})
	return out, e
}
