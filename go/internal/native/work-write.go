package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
	"unicode/utf16"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

const workDDL = `CREATE TABLE IF NOT EXISTS work_capture_scopes(host TEXT NOT NULL,session_id TEXT NOT NULL,owner_id TEXT NOT NULL,started_at TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(host,session_id));
CREATE TABLE IF NOT EXISTS work_sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,host TEXT NOT NULL,session_id TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',last_sequence INTEGER NOT NULL DEFAULT 0,UNIQUE(owner_id,host,session_id));
CREATE TABLE IF NOT EXISTS work_environments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,host TEXT NOT NULL,session_id TEXT NOT NULL,version INTEGER NOT NULL,observed_at TEXT NOT NULL,facts_json TEXT NOT NULL,exclusions_json TEXT NOT NULL DEFAULT '[]',UNIQUE(owner_id,host,session_id,version));
CREATE TABLE IF NOT EXISTS work_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,work_id TEXT NOT NULL,source_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,occurred_at TEXT,observed_at TEXT NOT NULL,source_json TEXT NOT NULL,content_json TEXT,details_json TEXT NOT NULL,environment_id TEXT,exclusions_json TEXT NOT NULL DEFAULT '[]',UNIQUE(work_id,source_id,revision));
CREATE INDEX IF NOT EXISTS work_observation_sources ON work_observations(work_id,source_id,revision);
CREATE TABLE IF NOT EXISTS work_summaries(work_id TEXT NOT NULL,revision INTEGER NOT NULL,through_sequence INTEGER NOT NULL,created_at TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,outcome TEXT NOT NULL,model TEXT,sources_json TEXT NOT NULL,execution_json TEXT,exclusions_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(work_id,revision));
CREATE TABLE IF NOT EXISTS work_summary_state(work_id TEXT PRIMARY KEY,state TEXT NOT NULL,code TEXT,updated_at TEXT NOT NULL);`

func (s *Store) historyWrite(ctx context.Context, requested string, scope *ChoiceScope, run func(*sql.DB, string) error) error {
	return s.With(ctx, true, func(dir string) error {
		if e := s.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		owner, e := s.ownerWithin(dir, requested)
		if e != nil {
			return e
		}
		if owner == "" {
			return fault.New("local_work_identity_required", 409)
		}
		folder := filepath.Join(dir, "work-history")
		if e = os.MkdirAll(folder, 0700); e != nil {
			return e
		}
		file := filepath.Join(folder, "history.sqlite")
		f, e := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
		if e != nil {
			return e
		}
		if e = f.Chmod(0600); e != nil {
			f.Close()
			return e
		}
		if e = f.Close(); e != nil {
			return e
		}
		db, e := openSQLite(file, true)
		if e != nil {
			return e
		}
		defer db.Close()
		if _, e = db.ExecContext(ctx, workDDL); e != nil {
			return e
		}
		for _, table := range []string{"work_environments", "work_observations", "work_summaries"} {
			cols, e := rowsMaps(ctx, db, "PRAGMA table_info("+table+")")
			if e != nil {
				return e
			}
			found := false
			for _, c := range cols {
				if text(c["name"]) == "exclusions_json" {
					found = true
				}
			}
			if !found {
				if _, e = db.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN exclusions_json TEXT NOT NULL DEFAULT '[]'"); e != nil {
					return e
				}
			}
		}
		if _, e = db.ExecContext(ctx, "BEGIN IMMEDIATE"); e != nil {
			return e
		}
		defer db.ExecContext(context.Background(), "ROLLBACK")
		if e = run(db, owner); e != nil {
			return e
		}
		_, e = db.ExecContext(ctx, "COMMIT")
		return e
	})
}

type WorkEnvironmentInput struct {
	GalaxyID   string          `json:"galaxyId,omitempty"`
	Host       string          `json:"host"`
	SessionID  string          `json:"sessionId"`
	Facts      json.RawMessage `json:"facts"`
	ObservedAt string          `json:"observedAt,omitempty"`
}
type WorkSource struct {
	Kind      string `json:"kind"`
	MessageID string `json:"messageId,omitempty"`
	PartID    string `json:"partId,omitempty"`
	EventID   string `json:"eventId,omitempty"`
	Locator   string `json:"locator,omitempty"`
}
type WorkContent struct {
	Excerpt           string `json:"excerpt"`
	OriginalLength    *int64 `json:"originalLength,omitempty"`
	Retained          string `json:"retained"`
	AvailableFromHost bool   `json:"availableFromHost"`
}
type WorkObservationInput struct {
	GalaxyID    string          `json:"galaxyId,omitempty"`
	Host        string          `json:"host"`
	SessionID   string          `json:"sessionId"`
	SourceID    string          `json:"sourceId"`
	Revision    *int64          `json:"revision,omitempty"`
	Kind        string          `json:"kind"`
	OccurredAt  string          `json:"occurredAt,omitempty"`
	Title       string          `json:"title,omitempty"`
	Source      WorkSource      `json:"source"`
	Content     *WorkContent    `json:"content,omitempty"`
	Details     json.RawMessage `json:"details,omitempty"`
	Environment json.RawMessage `json:"environment,omitempty"`
}
type WorkExecution struct {
	Host      string `json:"host"`
	SessionID string `json:"sessionId"`
	MessageID string `json:"messageId,omitempty"`
}
type WorkSummaryInput struct {
	GalaxyID             string         `json:"galaxyId,omitempty"`
	WorkID               string         `json:"workId"`
	ExpectedRevision     int64          `json:"expectedRevision"`
	ThroughSequence      int64          `json:"throughSequence"`
	SourceObservationIDs []string       `json:"sourceObservationIds"`
	Title                string         `json:"title"`
	Summary              string         `json:"summary"`
	Outcome              string         `json:"outcome,omitempty"`
	Model                string         `json:"model,omitempty"`
	Execution            *WorkExecution `json:"execution,omitempty"`
}

func workInvalid() error { return fault.New("local_work_input_invalid", 400) }

var workTimePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$`)

func validWorkTime(v string) bool {
	if v == "" {
		return true
	}
	if !workTimePattern.MatchString(v) {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, v)
	if e != nil {
		_, e = time.Parse("2006-01-02T15:04Z", v)
	}
	return e == nil
}
func validID(v string) bool    { return v != "" && protocol.TextLength(v) <= 512 }
func optionalID(v string) bool { return v == "" || validID(v) }
func isOne(v string, values ...string) bool {
	for _, s := range values {
		if v == s {
			return true
		}
	}
	return false
}
func truncateJS(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}
func jsJSON(v any) string { b, _ := localdata.Encode(v); return string(b) }
func nullableText(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func objectJSON(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	v, e := localdata.Parse(raw)
	if e != nil {
		return false
	}
	_, ok := v.(localdata.Object)
	return ok
}
func mergeWorkExclusions(groups ...[]localdata.Exclusion) []localdata.Exclusion {
	out := []localdata.Exclusion{}
	seen := map[localdata.Exclusion]bool{}
	for _, g := range groups {
		for _, v := range g {
			if !seen[v] {
				out = append(out, v)
				seen[v] = true
			}
		}
	}
	return out
}
func workExclusions(row map[string]any) []localdata.Exclusion {
	out := []localdata.Exclusion{}
	_ = json.Unmarshal([]byte(text(row["exclusions_json"])), &out)
	return out
}
func normalizeEnvironment(v any) localdata.Object {
	o, _ := v.(localdata.Object)
	values := map[string]any{}
	for _, f := range o {
		values[f.Key] = f.Value
	}
	out := localdata.Object{}
	for _, key := range []string{"host", "hostVersion", "platform", "architecture", "runtime", "runtimeVersion", "configuredModel", "selectedModel", "actualModel"} {
		if v, ok := values[key].(string); ok && v != "" {
			out = append(out, localdata.Field{Key: key, Value: truncateJS(v, 256)})
		}
	}
	if a, ok := values["tools"].([]any); ok {
		tools := []string{}
		seen := map[string]bool{}
		for _, v := range a {
			if s, ok := v.(string); ok {
				s = truncateJS(s, 160)
				if !seen[s] {
					seen[s] = true
					tools = append(tools, s)
				}
			}
		}
		sort.Slice(tools, func(i, j int) bool {
			a, b := utf16.Encode([]rune(tools[i])), utf16.Encode([]rune(tools[j]))
			for k := 0; k < len(a) && k < len(b); k++ {
				if a[k] != b[k] {
					return a[k] < b[k]
				}
			}
			return len(a) < len(b)
		})
		if len(tools) > 256 {
			tools = tools[:256]
		}
		out = append(out, localdata.Field{Key: "tools", Value: tools})
	}
	return out
}
func environmentWithin(ctx context.Context, db *sql.DB, owner string, x WorkEnvironmentInput) (map[string]any, error) {
	safe, e := localdata.RedactJSON(x.Facts)
	if e != nil {
		return nil, e
	}
	facts := normalizeEnvironment(safe.Value)
	encoded := jsJSON(facts)
	old, e := oneMap(ctx, db, "SELECT * FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version DESC LIMIT 1", owner, x.Host, x.SessionID)
	if e != nil {
		return nil, e
	}
	if text(old["facts_json"]) == encoded {
		exclusions := mergeWorkExclusions(workExclusions(old), safe.Exclusions)
		if jsJSON(exclusions) != text(old["exclusions_json"]) {
			if _, e = db.ExecContext(ctx, "UPDATE work_environments SET exclusions_json=? WHERE id=?", jsJSON(exclusions), old["id"]); e != nil {
				return nil, e
			}
		}
		return map[string]any{"id": old["id"], "version": old["version"], "observedAt": old["observed_at"], "facts": facts, "exclusions": exclusions, "changed": false}, nil
	}
	id := uuid.NewString()
	version := integer(old["version"]) + 1
	observed := x.ObservedAt
	if observed == "" {
		observed = localNow()
	}
	if _, e = db.ExecContext(ctx, "INSERT INTO work_environments(id,owner_id,host,session_id,version,observed_at,facts_json,exclusions_json) VALUES(?,?,?,?,?,?,?,?)", id, owner, x.Host, x.SessionID, version, observed, encoded, jsJSON(safe.Exclusions)); e != nil {
		return nil, e
	}
	return map[string]any{"id": id, "version": version, "observedAt": observed, "facts": facts, "exclusions": safe.Exclusions, "changed": true}, nil
}
func validateEnvironment(x WorkEnvironmentInput) error {
	if !optionalID(x.GalaxyID) || !validID(x.Host) || !validID(x.SessionID) || !objectJSON(x.Facts) || !validWorkTime(x.ObservedAt) {
		return workInvalid()
	}
	return nil
}
func (s *Store) ObserveWorkEnvironment(ctx context.Context, x WorkEnvironmentInput) (any, error) {
	if e := validateEnvironment(x); e != nil {
		return nil, e
	}
	var out any
	e := s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, id string) error {
		v, e := environmentWithin(ctx, db, id, x)
		if e == nil {
			v["galaxyId"] = id
			out = v
		}
		return e
	})
	return out, e
}
func (s *Store) BeginWorkCapture(ctx context.Context, x WorkEnvironmentInput) (any, error) {
	x.Facts = json.RawMessage(`{}`)
	if e := validateEnvironment(x); e != nil {
		return nil, e
	}
	var out any
	e := s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, id string) error {
		old, e := oneMap(ctx, db, "SELECT * FROM work_capture_scopes WHERE host=? AND session_id=?", x.Host, x.SessionID)
		if e != nil {
			return e
		}
		resumed := text(old["owner_id"]) == id
		started := x.ObservedAt
		if started == "" {
			started = localNow()
		}
		if resumed {
			started = text(old["started_at"])
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO work_capture_scopes(host,session_id,owner_id,started_at,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(host,session_id) DO UPDATE SET owner_id=excluded.owner_id,started_at=excluded.started_at,observed_at=excluded.observed_at", x.Host, x.SessionID, id, started, localNow()); e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "UPDATE work_summary_state SET state='pending',code='host_model_interrupted',updated_at=? WHERE state='running' AND work_id IN (SELECT id FROM work_sessions WHERE owner_id=? AND host=? AND session_id=?)", localNow(), id, x.Host, x.SessionID); e != nil {
			return e
		}
		out = map[string]any{"galaxyId": id, "host": x.Host, "sessionId": x.SessionID, "startedAt": started, "resumed": resumed}
		return nil
	})
	return out, e
}
func (s *Store) ObserveWork(ctx context.Context, x WorkObservationInput) (any, error) {
	if x.Content != nil {
		copy := *x.Content
		x.Content = &copy
	}
	if len(x.Details) == 0 {
		x.Details = json.RawMessage(`{}`)
	}
	if !optionalID(x.GalaxyID) || !validID(x.Host) || !validID(x.SessionID) || !validID(x.SourceID) || !isOne(x.Kind, "message", "tool", "session", "artifact", "claim", "gap") || !isOne(x.Source.Kind, "host-event", "user-statement", "model-report", "tool-report", "external-material") || !optionalID(x.Source.MessageID) || !optionalID(x.Source.PartID) || !optionalID(x.Source.EventID) || protocol.TextLength(x.Source.Locator) > 2048 || protocol.TextLength(x.Title) > 180 || !validWorkTime(x.OccurredAt) || !objectJSON(x.Details) || (len(x.Environment) > 0 && !objectJSON(x.Environment)) || (x.Revision != nil && *x.Revision < 0) {
		return nil, workInvalid()
	}
	if x.Content != nil {
		if x.Content.Retained == "" {
			x.Content.Retained = "none"
		}
		if protocol.TextLength(x.Content.Excerpt) > 4000 || !isOne(x.Content.Retained, "none", "excerpt", "full") || (x.Content.OriginalLength != nil && *x.Content.OriginalLength < 0) {
			return nil, workInvalid()
		}
	}
	safe, e := localdata.Redact(x)
	if e != nil {
		return nil, e
	}
	raw, e := localdata.Encode(safe.Value)
	if e != nil {
		return nil, e
	}
	if e = json.Unmarshal(raw, &x); e != nil {
		return nil, e
	}
	x.Title = truncateJS(x.Title, 180)
	if x.Content != nil {
		x.Content.Excerpt = truncateJS(x.Content.Excerpt, 4000)
		for _, v := range safe.Exclusions {
			if len(v.Path) >= 9 && v.Path[:9] == "$.content" && x.Content.Retained == "full" {
				x.Content.Retained = "excerpt"
			}
		}
	}
	detailsValue, e := localdata.Parse(x.Details)
	if e != nil {
		return nil, e
	}
	details := jsJSON(detailsValue)
	if len(details) > 16384 {
		return nil, fault.New("local_work_observation_too_large", 400)
	}
	source := jsJSON(x.Source)
	var content any
	if x.Content != nil {
		content = jsJSON(x.Content)
	}
	var out any
	e = s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, id string) error {
		work, e := findWork(ctx, db, id, WorkQuery{Host: x.Host, SessionID: x.SessionID})
		if e != nil {
			return e
		}
		now := localNow()
		if work == nil {
			workID := uuid.NewString()
			if _, e = db.ExecContext(ctx, "INSERT INTO work_sessions(id,owner_id,host,session_id,started_at,updated_at,title) VALUES(?,?,?,?,?,?,?)", workID, id, x.Host, x.SessionID, now, now, x.Title); e != nil {
				return e
			}
			work, e = findWork(ctx, db, id, WorkQuery{WorkID: workID})
			if e != nil {
				return e
			}
		}
		var env map[string]any
		if len(x.Environment) > 0 {
			env, e = environmentWithin(ctx, db, id, WorkEnvironmentInput{Host: x.Host, SessionID: x.SessionID, Facts: x.Environment})
		} else {
			env, e = oneMap(ctx, db, "SELECT id FROM work_environments WHERE owner_id=? AND host=? AND session_id=? ORDER BY version DESC LIMIT 1", id, x.Host, x.SessionID)
		}
		if e != nil {
			return e
		}
		old, e := oneMap(ctx, db, "SELECT * FROM work_observations WHERE work_id=? AND source_id=? ORDER BY revision DESC LIMIT 1", work["id"], x.SourceID)
		if e != nil {
			return e
		}
		same := func(r map[string]any) bool {
			return r != nil && r["kind"] == x.Kind && r["source_json"] == source && r["content_json"] == content && r["details_json"] == details && r["occurred_at"] == nullableText(x.OccurredAt)
		}
		if same(old) {
			exclusions := mergeWorkExclusions(workExclusions(old), safe.Exclusions)
			if _, e = db.ExecContext(ctx, "UPDATE work_observations SET exclusions_json=? WHERE id=?", jsJSON(exclusions), old["id"]); e != nil {
				return e
			}
			old["exclusions_json"] = jsJSON(exclusions)
			old["latest_revision"] = old["revision"]
			out = map[string]any{"workId": work["id"], "galaxyId": id, "duplicate": true, "observation": observationView(old)}
			return nil
		}
		revision := int64(0)
		if old != nil {
			revision = integer(old["revision"]) + 1
		}
		if x.Revision != nil {
			revision = *x.Revision
		}
		prior, e := oneMap(ctx, db, "SELECT * FROM work_observations WHERE work_id=? AND source_id=? AND revision=?", work["id"], x.SourceID, revision)
		if e != nil {
			return e
		}
		if prior != nil {
			if !same(prior) {
				return fault.New("local_work_source_revision_conflict", 409)
			}
			prior["latest_revision"] = prior["revision"]
			out = map[string]any{"workId": work["id"], "galaxyId": id, "duplicate": true, "observation": observationView(prior)}
			return nil
		}
		obsID := uuid.NewString()
		if _, e = db.ExecContext(ctx, "INSERT INTO work_observations(id,work_id,source_id,revision,kind,occurred_at,observed_at,source_json,content_json,details_json,environment_id,exclusions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", obsID, work["id"], x.SourceID, revision, x.Kind, nullableText(x.OccurredAt), now, source, content, details, env["id"], jsJSON(safe.Exclusions)); e != nil {
			return e
		}
		saved, e := oneMap(ctx, db, "SELECT * FROM work_observations WHERE id=?", obsID)
		if e != nil {
			return e
		}
		var detail map[string]any
		_ = json.Unmarshal(x.Details, &detail)
		updateTitle := x.Title != "" && x.Kind == "session" && x.Source.Kind == "host-event" && detail["event"] == "session-title" && (old == nil || revision >= integer(old["revision"]))
		if _, e = db.ExecContext(ctx, "UPDATE work_sessions SET updated_at=?,last_sequence=?,title=CASE WHEN title='' OR ? THEN ? ELSE title END WHERE id=?", now, saved["sequence"], updateTitle, x.Title, work["id"]); e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "UPDATE work_capture_scopes SET observed_at=? WHERE host=? AND session_id=? AND owner_id=?", now, x.Host, x.SessionID, id); e != nil {
			return e
		}
		latest := revision
		if integer(old["revision"]) > latest {
			latest = integer(old["revision"])
		}
		saved["latest_revision"] = latest
		out = map[string]any{"workId": work["id"], "galaxyId": id, "duplicate": false, "late": old != nil && revision < integer(old["revision"]), "observation": observationView(saved)}
		return nil
	})
	return out, e
}
func (s *Store) SubmitWorkSummary(ctx context.Context, x WorkSummaryInput) (any, error) {
	if x.Outcome == "" {
		x.Outcome = "unknown"
	}
	if !optionalID(x.GalaxyID) || !validID(x.WorkID) || x.ExpectedRevision < 0 || x.ThroughSequence < 0 || len(x.SourceObservationIDs) < 1 || len(x.SourceObservationIDs) > 500 || x.Title == "" || protocol.TextLength(x.Title) > 180 || x.Summary == "" || protocol.TextLength(x.Summary) > 12000 || protocol.TextLength(x.Model) > 256 || !isOne(x.Outcome, "unknown", "reported-success", "reported-failure", "partial", "cancelled") {
		return nil, workInvalid()
	}
	for _, id := range x.SourceObservationIDs {
		if !validID(id) {
			return nil, workInvalid()
		}
	}
	if x.Execution != nil && (!validID(x.Execution.Host) || !validID(x.Execution.SessionID) || !optionalID(x.Execution.MessageID)) {
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
	if e = json.Unmarshal(raw, &x); e != nil {
		return nil, e
	}
	x.Title = truncateJS(x.Title, 180)
	x.Summary = truncateJS(x.Summary, 12000)
	var out any
	e = s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, id string) error {
		work, e := findWork(ctx, db, id, WorkQuery{WorkID: x.WorkID})
		if e != nil {
			return e
		}
		if work == nil {
			return fault.New("local_work_unavailable", 404)
		}
		old, e := oneMap(ctx, db, "SELECT * FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1", work["id"])
		if e != nil {
			return e
		}
		if integer(old["revision"]) != x.ExpectedRevision {
			return fault.New("local_work_summary_revision_conflict", 409)
		}
		after := integer(old["through_sequence"])
		if x.ThroughSequence <= after || x.ThroughSequence > integer(work["last_sequence"]) {
			return fault.New("local_work_summary_coverage_invalid", 400)
		}
		covered, e := rowsMaps(ctx, db, "SELECT id FROM work_observations WHERE work_id=? AND sequence>? AND sequence<=?", work["id"], after, x.ThroughSequence)
		if e != nil {
			return e
		}
		sources := []string{}
		set := map[string]bool{}
		for _, v := range x.SourceObservationIDs {
			if !set[v] {
				sources = append(sources, v)
				set[v] = true
			}
		}
		if len(covered) == 0 {
			return fault.New("local_work_summary_sources_invalid", 400)
		}
		for _, r := range covered {
			if !set[text(r["id"])] {
				return fault.New("local_work_summary_sources_invalid", 400)
			}
		}
		for _, v := range sources {
			r, e := oneMap(ctx, db, "SELECT id FROM work_observations WHERE id=? AND work_id=? AND sequence<=?", v, work["id"], x.ThroughSequence)
			if e != nil {
				return e
			}
			if r == nil {
				return fault.New("local_work_summary_sources_invalid", 400)
			}
		}
		revision := x.ExpectedRevision + 1
		created := localNow()
		var execution any
		if x.Execution != nil {
			execution = jsJSON(x.Execution)
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO work_summaries(work_id,revision,through_sequence,created_at,title,summary,outcome,model,sources_json,execution_json,exclusions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)", work["id"], revision, x.ThroughSequence, created, x.Title, x.Summary, x.Outcome, nullableText(x.Model), jsJSON(sources), execution, jsJSON(safe.Exclusions)); e != nil {
			return e
		}
		state := "idle"
		if integer(work["last_sequence"]) > x.ThroughSequence {
			state = "pending"
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO work_summary_state(work_id,state,code,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,code=NULL,updated_at=excluded.updated_at", work["id"], state, created); e != nil {
			return e
		}
		out = map[string]any{"workId": work["id"], "galaxyId": id, "revision": revision, "throughSequence": x.ThroughSequence, "createdAt": created, "sourceKind": "user-model", "outcome": x.Outcome, "exclusions": safe.Exclusions, "localOnly": true}
		return nil
	})
	return out, e
}

type WorkSummaryStateInput struct {
	GalaxyID string  `json:"galaxyId,omitempty"`
	WorkID   string  `json:"workId"`
	State    string  `json:"state"`
	Code     *string `json:"code,omitempty"`
}

var summaryCode = regexp.MustCompile(`^[a-z0-9_]{1,120}$`)

func (s *Store) SetWorkSummaryState(ctx context.Context, x WorkSummaryStateInput) error {
	if !isOne(x.State, "running", "pending", "failed", "model-unavailable") || (x.Code != nil && !summaryCode.MatchString(*x.Code)) {
		return fault.New("local_work_summary_state_invalid", 400)
	}
	return s.historyWrite(ctx, x.GalaxyID, nil, func(db *sql.DB, id string) error {
		work, e := findWork(ctx, db, id, WorkQuery{WorkID: x.WorkID})
		if e != nil {
			return e
		}
		if work == nil {
			return fault.New("local_work_unavailable", 404)
		}
		_, e = db.ExecContext(ctx, "INSERT INTO work_summary_state(work_id,state,code,updated_at) VALUES(?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,code=excluded.code,updated_at=excluded.updated_at", x.WorkID, x.State, x.Code, localNow())
		return e
	})
}

type WorkNoteInput struct {
	GalaxyID   string `json:"galaxyId,omitempty"`
	Host       string `json:"host"`
	SessionID  string `json:"sessionId"`
	SourceID   string `json:"sourceId,omitempty"`
	Title      string `json:"title,omitempty"`
	Text       string `json:"text"`
	SourceKind string `json:"sourceKind,omitempty"`
}

func (s *Store) RecordWorkNote(ctx context.Context, x WorkNoteInput) (any, error) {
	if x.SourceKind == "" {
		x.SourceKind = "model-report"
	}
	if !optionalID(x.GalaxyID) || !validID(x.Host) || !validID(x.SessionID) || !optionalID(x.SourceID) || protocol.TextLength(x.Title) > 180 || x.Text == "" || protocol.TextLength(x.Text) > 4000 || !isOne(x.SourceKind, "user-statement", "model-report") {
		return nil, workInvalid()
	}
	if x.SourceID == "" {
		x.SourceID = uuid.NewString()
	}
	length := int64(protocol.TextLength(x.Text))
	return s.ObserveWork(ctx, WorkObservationInput{GalaxyID: x.GalaxyID, Host: x.Host, SessionID: x.SessionID, SourceID: x.SourceID, Kind: "claim", Title: x.Title, Source: WorkSource{Kind: x.SourceKind}, Content: &WorkContent{Excerpt: x.Text, OriginalLength: &length, Retained: "full"}, Details: json.RawMessage(`{"statementOnly":true}`)})
}
func (s *Store) DeleteWork(ctx context.Context, q WorkQuery) (any, error) {
	return s.deleteWork(ctx, q, nil)
}
func (s *Store) deleteWork(ctx context.Context, q WorkQuery, scope *ChoiceScope) (any, error) {
	if !validID(q.WorkID) || !optionalID(q.GalaxyID) {
		return nil, workInvalid()
	}
	var out any
	e := s.historyWrite(ctx, q.GalaxyID, scope, func(db *sql.DB, id string) error {
		work, e := findWork(ctx, db, id, q)
		if e != nil {
			return e
		}
		if work == nil {
			return fault.New("local_work_unavailable", 404)
		}
		for _, table := range []string{"work_observations", "work_summaries", "work_summary_state"} {
			if _, e = db.ExecContext(ctx, "DELETE FROM "+table+" WHERE work_id=?", work["id"]); e != nil {
				return e
			}
		}
		for _, table := range []string{"work_environments", "work_capture_scopes"} {
			if _, e = db.ExecContext(ctx, "DELETE FROM "+table+" WHERE owner_id=? AND host=? AND session_id=?", id, work["host"], work["session_id"]); e != nil {
				return e
			}
		}
		if _, e = db.ExecContext(ctx, "DELETE FROM work_sessions WHERE owner_id=? AND id=?", id, work["id"]); e != nil {
			return e
		}
		if e = s.cancelDeletedSourceQueueWithin(ctx, id, text(work["id"]), false); e != nil {
			return e
		}
		out = map[string]any{"workId": work["id"], "galaxyId": id, "deleted": true, "hostOriginalsAffected": false, "conversationArchiveAffected": false}
		return nil
	})
	return out, e
}
