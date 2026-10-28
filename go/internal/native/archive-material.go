package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type ArchiveQuery struct {
	GalaxyID         string `json:"galaxyId,omitempty"`
	ArchiveSessionID string `json:"archiveSessionId,omitempty"`
	Host             string `json:"host,omitempty"`
	SessionID        string `json:"sessionId,omitempty"`
	After            string `json:"after,omitempty"`
	AfterSequence    int64  `json:"afterSequence,omitempty"`
	Limit            int    `json:"limit,omitempty"`
}

// RawMessage preserves host JSON object order for the existing byte-based deduplication.
type ArchiveCaptureInput struct {
	GalaxyID    string          `json:"galaxyId,omitempty"`
	Host        string          `json:"host"`
	SessionID   string          `json:"sessionId"`
	MessageID   string          `json:"messageId"`
	Message     json.RawMessage `json:"message,omitempty"`
	Parts       json.RawMessage `json:"parts,omitempty"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
}

func localNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func archiveView(r map[string]any) any {
	var workspace any = r["workspace_id"]
	return map[string]any{"archiveSessionId": r["id"], "host": r["host"], "sessionId": r["session_id"], "createdAt": r["created_at"], "updatedAt": r["updated_at"], "workspaceId": workspace, "revision": integer(r["revision"]), "messageCount": integer(r["message_count"]), "coverage": "captured-host-messages-only", "localOnly": true}
}
func archiveMessageView(r map[string]any) (any, error) {
	var stored struct {
		Message    json.RawMessage       `json:"message"`
		Parts      json.RawMessage       `json:"parts"`
		Exclusions []localdata.Exclusion `json:"exclusions"`
	}
	if e := json.Unmarshal([]byte(text(r["body_json"])), &stored); e != nil {
		return nil, e
	}
	raw := archiveBody(stored.Message, stored.Parts)
	safe, e := localdata.RedactJSON(raw)
	if e != nil {
		return nil, e
	}
	o := safe.Value.(localdata.Object)
	out := map[string]any{"sequence": r["sequence"], "messageId": r["message_id"], "capturedAt": r["captured_at"], "exclusions": append(stored.Exclusions, safe.Exclusions...)}
	if out["exclusions"].([]localdata.Exclusion) == nil {
		out["exclusions"] = []localdata.Exclusion{}
	}
	for _, f := range o {
		out[f.Key] = f.Value
	}
	return out, nil
}
func archiveBody(message, parts json.RawMessage) []byte {
	b := []byte("{")
	if len(message) > 0 {
		b = append(b, []byte(`"message":`)...)
		b = append(b, message...)
	}
	if len(parts) > 0 {
		if len(message) > 0 {
			b = append(b, ',')
		}
		b = append(b, []byte(`"parts":`)...)
		b = append(b, parts...)
	}
	return append(b, '}')
}
func archiveSelected(p ArchiveSettings, host, session string) bool {
	if !p.Enabled {
		return false
	}
	for _, s := range p.Sessions {
		if s.Host == host && s.SessionID == session {
			return true
		}
	}
	return false
}
func archiveCleanupWithin(ctx context.Context, db *sql.DB, owner string, p ArchiveSettings) (int64, error) {
	if p.AutoCleanAfterDays == nil {
		return 0, nil
	}
	cutoff := time.Now().UTC().Add(-time.Duration(*p.AutoCleanAfterDays) * 24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	r, e := db.ExecContext(ctx, "DELETE FROM archive_messages WHERE session_id IN (SELECT id FROM archive_sessions WHERE owner_id=?) AND captured_at<?", owner, cutoff)
	if e != nil {
		return 0, e
	}
	return r.RowsAffected()
}
func (s *Store) CaptureArchiveMessage(ctx context.Context, x ArchiveCaptureInput) (any, error) {
	for _, v := range []string{x.Host, x.SessionID, x.MessageID} {
		if v == "" || protocol.TextLength(v) > 512 {
			return nil, fault.New("local_archive_capture_invalid", 400)
		}
	}
	if protocol.TextLength(x.WorkspaceID) > 512 {
		return nil, fault.New("local_archive_workspace_invalid", 400)
	}
	var owner string
	var selected ArchiveSettings
	e := s.archive(ctx, false, x.GalaxyID, nil, func(db *sql.DB, id string) error {
		owner = id
		var e error
		selected, e = archivePreferences(ctx, db, id)
		return e
	})
	if e != nil {
		return nil, e
	}
	if !archiveSelected(selected, x.Host, x.SessionID) {
		return map[string]any{"captured": false, "reason": "not-selected"}, nil
	}
	if selected.AutoCleanAfterDays != nil && len(x.Message) > 0 {
		var m map[string]any
		d := json.NewDecoder(strings.NewReader(string(x.Message)))
		d.UseNumber()
		if e = d.Decode(&m); e != nil {
			return nil, e
		}
		var source any
		if t, ok := m["time"].(map[string]any); ok {
			source = t["updated"]
			if source == nil {
				source = t["created"]
			}
		}
		if source == nil {
			source = m["updatedAt"]
		}
		if source == nil {
			source = m["createdAt"]
		}
		var when time.Time
		switch v := source.(type) {
		case json.Number:
			n, err := v.Float64()
			if err == nil {
				if n < 1e12 {
					n *= 1000
				}
				when = time.UnixMilli(int64(n))
			}
		case string:
			when, _ = time.Parse(time.RFC3339Nano, v)
		}
		if !when.IsZero() && when.Before(time.Now().Add(-time.Duration(*selected.AutoCleanAfterDays)*24*time.Hour)) {
			return map[string]any{"captured": false, "reason": "outside-selected-retention", "sourcePreservedInHost": true}, nil
		}
	}
	safe, e := localdata.RedactJSON(archiveBody(x.Message, x.Parts))
	if e != nil {
		return nil, e
	}
	o := append(safe.Value.(localdata.Object), localdata.Field{Key: "exclusions", Value: safe.Exclusions})
	body, e := localdata.Encode(o)
	if e != nil {
		return nil, e
	}
	if len(body) > 8<<20 {
		return map[string]any{"captured": false, "reason": "message-too-large", "sourcePreservedInHost": true}, nil
	}
	var out any
	e = s.archive(ctx, true, owner, nil, func(db *sql.DB, id string) error {
		p, e := archivePreferences(ctx, db, id)
		if e != nil {
			return e
		}
		if !archiveSelected(p, x.Host, x.SessionID) {
			out = map[string]any{"captured": false, "reason": "not-selected"}
			return nil
		}
		if _, e = archiveCleanupWithin(ctx, db, id, p); e != nil {
			return e
		}
		session, e := oneMap(ctx, db, "SELECT id,workspace_id FROM archive_sessions WHERE owner_id=? AND host=? AND session_id=?", id, x.Host, x.SessionID)
		if e != nil {
			return e
		}
		if session == nil {
			return fault.New("local_archive_session_unavailable", 404)
		}
		old, e := oneMap(ctx, db, "SELECT body_json FROM archive_messages WHERE session_id=? AND message_id=?", session["id"], x.MessageID)
		if e != nil {
			return e
		}
		if text(old["body_json"]) == string(body) && (x.WorkspaceID == "" || x.WorkspaceID == text(session["workspace_id"])) {
			out = map[string]any{"captured": true, "duplicate": true, "archiveSessionId": session["id"]}
			return nil
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO archive_messages(session_id,message_id,captured_at,body_json) VALUES(?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET captured_at=excluded.captured_at,body_json=excluded.body_json", session["id"], x.MessageID, localNow(), string(body)); e != nil {
			return e
		}
		var workspace any
		if x.WorkspaceID != "" {
			workspace = x.WorkspaceID
		}
		if _, e = db.ExecContext(ctx, "UPDATE archive_sessions SET updated_at=?,workspace_id=COALESCE(?,workspace_id),revision=revision+1 WHERE id=?", localNow(), workspace, session["id"]); e != nil {
			return e
		}
		out = map[string]any{"captured": true, "archiveSessionId": session["id"], "sourceKind": "host-original-with-exclusions", "exclusions": safe.Exclusions, "localOnly": true}
		return nil
	})
	return out, e
}
func validateArchiveQuery(q ArchiveQuery, session bool) error {
	if protocol.TextLength(q.GalaxyID) > 512 || q.AfterSequence < 0 || protocol.TextLength(q.After) > 200 {
		return fault.New("local_archive_input_invalid", 400)
	}
	if session {
		if _, e := uuid.Parse(q.ArchiveSessionID); e != nil {
			return fault.New("local_archive_input_invalid", 400)
		}
	}
	return nil
}
func (s *Store) ArchiveList(ctx context.Context, q ArchiveQuery) (any, error) {
	if e := validateArchiveQuery(q, false); e != nil {
		return nil, e
	}
	if q.Limit == 0 {
		q.Limit = 30
	}
	if q.Limit < 1 || q.Limit > 100 {
		return nil, fault.New("local_archive_input_invalid", 400)
	}
	var out any
	e := s.archive(ctx, false, q.GalaxyID, nil, func(db *sql.DB, id string) error {
		items := []any{}
		var next any
		if db != nil {
			var afterTime, afterID any
			if q.After != "" {
				p := strings.Split(q.After, "|")
				if len(p) < 2 || p[0] == "" || p[1] == "" {
					return fault.New("local_archive_cursor_invalid", 400)
				}
				afterTime = p[0]
				afterID = p[1]
			}
			rows, e := rowsMaps(ctx, db, "SELECT s.*, (SELECT count(*) FROM archive_messages m WHERE m.session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND (? IS NULL OR updated_at<? OR (updated_at=? AND id>?)) ORDER BY updated_at DESC,id LIMIT ?", id, afterTime, afterTime, afterTime, afterID, q.Limit+1)
			if e != nil {
				return e
			}
			if len(rows) > q.Limit {
				next = text(rows[q.Limit-1]["updated_at"]) + "|" + text(rows[q.Limit-1]["id"])
				rows = rows[:q.Limit]
			}
			for _, r := range rows {
				items = append(items, archiveView(r))
			}
		}
		var owner any
		if id != "" {
			owner = id
		}
		out = map[string]any{"galaxyId": owner, "items": items, "nextAfter": next, "localOnly": true}
		return nil
	})
	return out, e
}
func (s *Store) ArchiveExport(ctx context.Context, q ArchiveQuery) (any, error) {
	return s.archiveMaterial(ctx, q, false)
}
func (s *Store) ArchiveSnapshot(ctx context.Context, q ArchiveQuery) (any, error) {
	return s.archiveMaterial(ctx, q, true)
}
func (s *Store) archiveMaterial(ctx context.Context, q ArchiveQuery, snapshot bool) (any, error) {
	if e := validateArchiveQuery(q, true); e != nil {
		return nil, e
	}
	if q.Limit == 0 {
		q.Limit = 20
	}
	if q.Limit < 1 || q.Limit > 100 {
		return nil, fault.New("local_archive_input_invalid", 400)
	}
	var out any
	e := s.archive(ctx, false, q.GalaxyID, nil, func(db *sql.DB, id string) error {
		if db == nil {
			return fault.New("local_archive_session_unavailable", 404)
		}
		session, e := oneMap(ctx, db, "SELECT s.*,(SELECT count(*) FROM archive_messages WHERE session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND id=?", id, q.ArchiveSessionID)
		if e != nil {
			return e
		}
		if session == nil {
			return fault.New("local_archive_session_unavailable", 404)
		}
		query := "SELECT sequence,message_id,captured_at,body_json FROM archive_messages WHERE session_id=? AND sequence>? ORDER BY sequence"
		args := []any{session["id"], q.AfterSequence}
		if !snapshot {
			query += " LIMIT ?"
			args = append(args, q.Limit+1)
		}
		rows, e := db.QueryContext(ctx, query, args...)
		if e != nil {
			return e
		}
		defer rows.Close()
		messages := []any{}
		bytes := 0
		last := q.AfterSequence
		more := false
		for rows.Next() {
			if !snapshot && len(messages) == q.Limit {
				more = true
				break
			}
			var sequence int64
			var messageID, capturedAt, body string
			if e = rows.Scan(&sequence, &messageID, &capturedAt, &body); e != nil {
				return e
			}
			r := map[string]any{"sequence": sequence, "message_id": messageID, "captured_at": capturedAt, "body_json": body}
			m, e := archiveMessageView(r)
			if e != nil {
				return e
			}
			encoded, e := localdata.Encode(m)
			if e != nil {
				return e
			}
			if snapshot && len(messages) > 0 && bytes+len(encoded) > 32<<20 {
				more = true
				break
			}
			messages = append(messages, m)
			bytes += len(encoded)
			last = integer(r["sequence"])
		}
		if e = rows.Err(); e != nil {
			return e
		}
		var next any
		if more {
			next = last
		}
		coverage := "Only host originals actually captured after explicit selection, with credentials/inline binary excluded and listed per message. Earlier, missing or host-unexportable content is not reconstructed."
		v := map[string]any{"galaxyId": id, "session": archiveView(session), "messages": messages, "nextAfter": next, "completeConversation": false, "coverage": coverage, "localOnly": true}
		if snapshot {
			v["coverage"] = "Selected retained host messages in this sequence window; credentials and unavailable content are excluded."
			v["selectedCoverage"] = map[string]any{"afterSequence": q.AfterSequence, "throughSequence": last, "sourceMessages": session["message_count"], "hasEarlier": q.AfterSequence > 0, "hasLater": more}
		}
		out = v
		return nil
	})
	return out, e
}
func (s *Store) ArchiveDescribe(ctx context.Context, q ArchiveQuery) (any, error) {
	if e := validateArchiveQuery(q, true); e != nil {
		return nil, e
	}
	return s.archiveFind(ctx, q, false)
}
func (s *Store) ArchiveFindSession(ctx context.Context, q ArchiveQuery) (any, error) {
	if q.Host == "" || q.SessionID == "" || protocol.TextLength(q.Host) > 512 || protocol.TextLength(q.SessionID) > 512 {
		return nil, fault.New("local_archive_input_invalid", 400)
	}
	return s.archiveFind(ctx, q, true)
}
func (s *Store) archiveFind(ctx context.Context, q ArchiveQuery, byHost bool) (any, error) {
	var out any
	e := s.archive(ctx, false, q.GalaxyID, nil, func(db *sql.DB, id string) error {
		if db == nil {
			return nil
		}
		query := "SELECT s.*,(SELECT count(*) FROM archive_messages WHERE session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND id=?"
		args := []any{id, q.ArchiveSessionID}
		if byHost {
			query = "SELECT s.*,(SELECT count(*) FROM archive_messages WHERE session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND host=? AND session_id=?"
			args = []any{id, q.Host, q.SessionID}
		}
		r, e := oneMap(ctx, db, query, args...)
		if e != nil {
			return e
		}
		if r != nil {
			out = archiveView(r)
		}
		return nil
	})
	return out, e
}
func (s *Store) ArchiveCleanup(ctx context.Context, q ArchiveQuery) (any, error) {
	if e := validateArchiveQuery(q, false); e != nil {
		return nil, e
	}
	var owner string
	var p ArchiveSettings
	e := s.archive(ctx, false, q.GalaxyID, nil, func(db *sql.DB, id string) error {
		owner = id
		var e error
		p, e = archivePreferences(ctx, db, id)
		return e
	})
	if e != nil {
		return nil, e
	}
	var out any = map[string]any{"galaxyId": nil, "deletedMessages": 0, "localOnly": true}
	if owner != "" {
		out.(map[string]any)["galaxyId"] = owner
	}
	if p.AutoCleanAfterDays == nil {
		return out, nil
	}
	e = s.archive(ctx, true, owner, nil, func(db *sql.DB, id string) error {
		p, e := archivePreferences(ctx, db, id)
		if e != nil {
			return e
		}
		n, e := archiveCleanupWithin(ctx, db, id, p)
		out = map[string]any{"galaxyId": id, "deletedMessages": n, "localOnly": true}
		return e
	})
	return out, e
}
func (s *Store) ArchiveDelete(ctx context.Context, q ArchiveQuery) (any, error) {
	return s.archiveDelete(ctx, q, nil)
}
func (s *Store) archiveDelete(ctx context.Context, q ArchiveQuery, scope *ChoiceScope) (any, error) {
	if e := validateArchiveQuery(q, true); e != nil {
		return nil, e
	}
	var out any
	e := s.archive(ctx, true, q.GalaxyID, scope, func(db *sql.DB, id string) error {
		r, e := oneMap(ctx, db, "SELECT * FROM archive_sessions WHERE owner_id=? AND id=?", id, q.ArchiveSessionID)
		if e != nil {
			return e
		}
		if r == nil {
			return fault.New("local_archive_session_unavailable", 404)
		}
		result, e := db.ExecContext(ctx, "DELETE FROM archive_messages WHERE session_id=?", r["id"])
		if e != nil {
			return e
		}
		n, e := result.RowsAffected()
		if e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "DELETE FROM archive_sessions WHERE id=?", r["id"]); e != nil {
			return e
		}
		p, e := archivePreferences(ctx, db, id)
		if e != nil {
			return e
		}
		sessions := []ArchiveSession{}
		for _, v := range p.Sessions {
			if v.Host != text(r["host"]) || v.SessionID != text(r["session_id"]) {
				sessions = append(sessions, v)
			}
		}
		p.Sessions = sessions
		if len(sessions) == 0 {
			p.Enabled = false
		}
		raw, e := protocol.Encode(p)
		if e != nil {
			return e
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO archive_preferences(owner_id,settings_json) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET settings_json=excluded.settings_json", id, string(raw)); e != nil {
			return e
		}
		if e = s.cancelDeletedSourceQueueWithin(ctx, id, text(r["id"]), true); e != nil {
			return e
		}
		out = map[string]any{"galaxyId": id, "archiveSessionId": r["id"], "deletedMessages": n, "hostOriginalsChanged": false, "cloudReplicasChanged": false, "localOnly": true}
		return nil
	})
	return out, e
}
