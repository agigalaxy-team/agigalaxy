package accountarchive

import (
	"context"
	"encoding/base64"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	query := "SELECT row_to_json(r) FROM (" + sql + ") r"
	if !strings.HasPrefix(sql, "SELECT") {
		query = "WITH r AS (" + sql + ") SELECT row_to_json(r) FROM r"
	}
	var raw []byte
	e := tx.QueryRow(ctx, query, args...).Scan(&raw)
	if absentRow(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(raw, &out)
	return out, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	result, e := tx.Query(ctx, "SELECT row_to_json(r) FROM ("+sql+") r", args...)
	if e != nil {
		return nil, e
	}
	defer result.Close()
	out := []Object{}
	for result.Next() {
		var raw []byte
		if e = result.Scan(&raw); e != nil {
			return nil, e
		}
		var v Object
		if e = protocol.Decode(raw, &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, result.Err()
}
func date(v any) any {
	if v == nil {
		return nil
	}
	t, e := time.Parse(time.RFC3339Nano, v.(string))
	if e != nil {
		return v
	}
	return stamp(t)
}
func archiveView(r Object) Object {
	return Object{"id": r["id"], "title": r["title"], "selection": r["selection"], "state": r["state"], "originSubjectId": r["origin_subject_id"], "byteLength": r["byte_length"], "chunkCount": r["chunk_count"], "createdAt": date(r["created_at"]), "updatedAt": date(r["updated_at"]), "expiresAt": date(r["expires_at"]), "visibility": "Private"}
}
func (s *Service) cleanup(ctx context.Context, tx pgx.Tx, a Actor) (Object, error) {
	rr, e := tx.Query(ctx, `WITH expired AS (DELETE FROM private_conversation_archives_v1 WHERE id IN
 (SELECT id FROM private_conversation_archives_v1 WHERE expires_at<=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3) ORDER BY expires_at,id LIMIT 100)
 RETURNING id,account_id,selection,origin_subject_id)
 INSERT INTO private_conversation_deletions_v1(archive_id,account_id,scope_id,origin_subject_id,reason,deleted_at)
 SELECT id,account_id,(selection->>'scopeId')::uuid,origin_subject_id,'expired',$1 FROM expired ON CONFLICT(archive_id) DO NOTHING RETURNING archive_id::text`, s.now(), a.AccountID, origin(a))
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	ids := []string{}
	for rr.Next() {
		var id string
		if e = rr.Scan(&id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return Object{"deleted": ids}, rr.Err()
}
func (s *Service) archive(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
	r, e := row(ctx, tx, `SELECT * FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3) FOR UPDATE`, id, a.AccountID, origin(a))
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fault.New("not_found", 404)
	}
	if r["expires_at"] != nil {
		at, e := time.Parse(time.RFC3339Nano, str(r, "expires_at"))
		if e != nil {
			return nil, e
		}
		if !at.After(s.now()) {
			return nil, fault.New("not_found", 404)
		}
	}
	return r, nil
}
func (s *Service) Archive(ctx context.Context, a Actor, action string, raw []byte) (Object, error) {
	keys := map[string][]string{"create": {"id", "title", "selection", "uploadLevel", "includeFullConversation"}, "chunk": {"id", "sequence", "content"}, "complete": {"id", "chunkCount"}, "list": {"after", "limit"}, "status": {"id"}, "export": {"id", "sequence"}, "delete": {"id"}, "cleanup": {}}
	allowed, ok := keys[action]
	if !ok {
		return nil, fault.New("not_found", 404)
	}
	p, e := input(raw, "invalid_account_data", allowed)
	if e != nil {
		return nil, e
	}
	id := str(p, "id")
	if action != "list" && action != "cleanup" && !validID(id) {
		return nil, fault.New("invalid_account_data", 400)
	}
	resource := action == "create" || action == "chunk" || action == "complete"
	return s.run(ctx, a, false, resource, func(tx pgx.Tx, current Actor) (Object, error) {
		a = current
		switch action {
		case "cleanup":
			return s.cleanup(ctx, tx, a)
		case "create":
			title := strings.Trim(str(p, "title"), " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
			selection, ok := p["selection"].(map[string]any)
			if !ok || !text(title, 1, 240) || p["uploadLevel"] != "conversation-archive" || p["includeFullConversation"] != true {
				return nil, fault.New("invalid_account_data", 400)
			}
			selection, e = input(encoded(selection), "invalid_account_data", []string{"workspaceId", "sessionIds", "scopeId"})
			if e != nil {
				return nil, e
			}
			workspace, present := selection["workspaceId"]
			if !present || (workspace != nil && !text(workspace, 1, 512)) {
				return nil, fault.New("invalid_account_data", 400)
			}
			sessions, ok := selection["sessionIds"].([]any)
			if !ok || len(sessions) < 1 || len(sessions) > 1000 {
				return nil, fault.New("invalid_account_data", 400)
			}
			seen := map[string]bool{}
			for _, v := range sessions {
				if !text(v, 1, 256) {
					return nil, fault.New("invalid_account_data", 400)
				}
				v := v.(string)
				if seen[v] {
					return nil, fault.New("invalid_archive_selection", 400)
				}
				seen[v] = true
			}
			scope := selection["scopeId"]
			if scope != nil && !validID(str(selection, "scopeId")) {
				return nil, fault.New("invalid_account_data", 400)
			}
			if _, ok = selection["scopeId"]; ok && scope == nil {
				return nil, fault.New("invalid_account_data", 400)
			}
			if e = s.ensure(ctx, tx, a.AccountID); e != nil {
				return nil, e
			}
			var retention *int
			if e = tx.QueryRow(ctx, `SELECT archive_retention_days FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE`, a.AccountID).Scan(&retention); e != nil {
				return nil, e
			}
			var deleted bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM private_conversation_deletions_v1 WHERE account_id=$1 AND (archive_id=$2 OR ($3::uuid IS NOT NULL AND scope_id=$3 AND reason='owner-deleted')))`, a.AccountID, id, scope).Scan(&deleted); e != nil {
				return nil, e
			}
			if deleted {
				return nil, fault.New("archive_deleted", 409)
			}
			var expires any
			if retention != nil {
				expires = s.now().Add(time.Duration(*retention) * 24 * time.Hour)
			}
			r, e := row(ctx, tx, `INSERT INTO private_conversation_archives_v1(id,account_id,origin_subject_id,title,selection,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING *`, id, a.AccountID, origin(a), title, string(encoded(selection)), s.now(), expires)
			if e != nil {
				return nil, e
			}
			if r != nil {
				return archiveView(r), nil
			}
			r, e = row(ctx, tx, `SELECT * FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2`, id, a.AccountID)
			if e != nil {
				return nil, e
			}
			if r == nil || r["origin_subject_id"] != origin(a) || r["title"] != title || !reflect.DeepEqual(r["selection"], selection) {
				return nil, fault.New("archive_conflict", 409)
			}
			return archiveView(r), nil
		case "chunk":
			seq, ok := integer(p, "sequence", 0, 65535)
			content, good := p["content"].(string)
			if !ok || !good || len(content) == 0 {
				return nil, fault.New("invalid_account_data", 400)
			}
			size := len([]byte(content))
			if size > 262144 {
				return nil, fault.New("archive_chunk_too_large", 413)
			}
			r, e := s.archive(ctx, tx, a, id)
			if e != nil {
				return nil, e
			}
			old, e := row(ctx, tx, `SELECT content FROM private_conversation_chunks_v1 WHERE archive_id=$1 AND sequence=$2`, id, seq)
			if e != nil {
				return nil, e
			}
			if old != nil {
				if old["content"] != content {
					return nil, fault.New("archive_chunk_conflict", 409)
				}
				return Object{"id": id, "sequence": seq, "stored": true}, nil
			}
			if r["state"] != "uploading" {
				return nil, fault.New("archive_already_complete", 409)
			}
			length, _ := number(r["byte_length"])
			if length+int64(size) > 67108864 {
				return nil, fault.New("archive_too_large", 413)
			}
			if _, e = tx.Exec(ctx, `INSERT INTO private_conversation_chunks_v1(archive_id,sequence,content,byte_length) VALUES($1,$2,$3,$4)`, id, seq, content, size); e != nil {
				return nil, e
			}
			_, e = tx.Exec(ctx, `UPDATE private_conversation_archives_v1 SET byte_length=byte_length+$2,updated_at=$3 WHERE id=$1`, id, size, s.now())
			return Object{"id": id, "sequence": seq, "stored": true}, e
		case "complete":
			n, ok := integer(p, "chunkCount", 1, 65536)
			if !ok {
				return nil, fault.New("invalid_account_data", 400)
			}
			r, e := s.archive(ctx, tx, a, id)
			if e != nil {
				return nil, e
			}
			if r["state"] == "ready" {
				old, _ := number(r["chunk_count"])
				if old != n {
					return nil, fault.New("archive_conflict", 409)
				}
				return archiveView(r), nil
			}
			chunks, e := rows(ctx, tx, `SELECT sequence FROM private_conversation_chunks_v1 WHERE archive_id=$1 ORDER BY sequence`, id)
			if e != nil {
				return nil, e
			}
			if int64(len(chunks)) != n {
				return nil, fault.New("archive_incomplete", 409)
			}
			for i, v := range chunks {
				seq, _ := number(v["sequence"])
				if seq != int64(i) {
					return nil, fault.New("archive_incomplete", 409)
				}
			}
			r, e = row(ctx, tx, `UPDATE private_conversation_archives_v1 SET state='ready',chunk_count=$2,updated_at=$3 WHERE id=$1 RETURNING *`, id, n, s.now())
			if e != nil {
				return nil, e
			}
			return archiveView(r), nil
		case "export":
			seq, ok := integer(p, "sequence", 0, 9007199254740991)
			if !ok {
				return nil, fault.New("invalid_account_data", 400)
			}
			r, e := s.archive(ctx, tx, a, id)
			if e != nil {
				return nil, e
			}
			if r["state"] != "ready" {
				return nil, fault.New("archive_incomplete", 409)
			}
			c, e := row(ctx, tx, `SELECT content FROM private_conversation_chunks_v1 WHERE archive_id=$1 AND sequence=$2`, id, seq)
			if e != nil {
				return nil, e
			}
			if c == nil {
				return nil, fault.New("not_found", 404)
			}
			count, _ := number(r["chunk_count"])
			var next any
			if seq+1 < count {
				next = seq + 1
			}
			return Object{"archive": archiveView(r), "sequence": seq, "content": c["content"], "nextSequence": next}, nil
		case "delete":
			if e = s.ensure(ctx, tx, a.AccountID); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `SELECT account_id FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE`, a.AccountID); e != nil {
				return nil, e
			}
			r, e := row(ctx, tx, `DELETE FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3) RETURNING selection,origin_subject_id`, id, a.AccountID, origin(a))
			if e != nil {
				return nil, e
			}
			if r != nil {
				selection := r["selection"].(map[string]any)
				_, e = tx.Exec(ctx, `INSERT INTO private_conversation_deletions_v1(archive_id,account_id,scope_id,origin_subject_id,reason,deleted_at) VALUES($1,$2,$3,$4,'owner-deleted',$5) ON CONFLICT(archive_id) DO NOTHING`, id, a.AccountID, selection["scopeId"], r["origin_subject_id"], s.now())
				if e != nil {
					return nil, e
				}
			}
			var deleted bool
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM private_conversation_deletions_v1 WHERE archive_id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3))`, id, a.AccountID, origin(a)).Scan(&deleted)
			return Object{"id": id, "deleted": r != nil || deleted}, e
		case "status":
			if _, e = s.cleanup(ctx, tx, a); e != nil {
				return nil, e
			}
			r, e := row(ctx, tx, `SELECT * FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)`, id, a.AccountID, origin(a))
			if e != nil {
				return nil, e
			}
			if r != nil {
				if r["expires_at"] != nil {
					at, _ := time.Parse(time.RFC3339Nano, str(r, "expires_at"))
					if !at.After(s.now()) {
						return Object{"id": id, "state": "expired", "cleanupPending": true, "storedSequences": []int{}}, nil
					}
				}
				cc, e := rows(ctx, tx, `SELECT sequence FROM private_conversation_chunks_v1 WHERE archive_id=$1 ORDER BY sequence`, id)
				if e != nil {
					return nil, e
				}
				ss := []any{}
				for _, c := range cc {
					ss = append(ss, c["sequence"])
				}
				return Object{"id": id, "state": r["state"], "archive": archiveView(r), "storedSequences": ss}, nil
			}
			r, e = row(ctx, tx, `SELECT reason,deleted_at,scope_id FROM private_conversation_deletions_v1 WHERE archive_id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)`, id, a.AccountID, origin(a))
			if e != nil {
				return nil, e
			}
			if r == nil {
				return Object{"id": id, "state": "absent", "storedSequences": []int{}}, nil
			}
			return Object{"id": id, "state": "deleted", "reason": r["reason"], "scopeId": r["scope_id"], "deletedAt": date(r["deleted_at"]), "storedSequences": []int{}}, nil
		case "list":
			return s.listArchives(ctx, tx, a, p)
		}
		return nil, fault.New("not_found", 404)
	})
}

type archiveCursor struct {
	Version   int    `json:"version"`
	AccountID string `json:"accountId"`
	Origin    any    `json:"originSubjectId"`
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

var archiveAfterPattern = regexp.MustCompile(`^ac1\.[A-Za-z0-9_-]+$`)

func (s *Service) listArchives(ctx context.Context, tx pgx.Tx, a Actor, p Object) (Object, error) {
	limit := int64(50)
	if _, ok := p["limit"]; ok {
		var valid bool
		limit, valid = integer(p, "limit", 1, 100)
		if !valid {
			return nil, fault.New("invalid_account_data", 400)
		}
	}
	if _, e := s.cleanup(ctx, tx, a); e != nil {
		return nil, e
	}
	var at, id any
	if v, ok := p["after"]; ok {
		value, ok := v.(string)
		if !ok || protocol.TextLength(value) > 512 || !validID(value) && !archiveAfterPattern.MatchString(value) {
			return nil, fault.New("invalid_account_data", 400)
		}
		if validID(value) {
			r, e := row(ctx, tx, `SELECT created_at,id FROM private_conversation_archives_v1 WHERE id=$1 AND account_id=$2 AND ($3::text IS NULL OR origin_subject_id=$3)`, value, a.AccountID, origin(a))
			if e != nil {
				return nil, e
			}
			if r == nil {
				return nil, fault.New("invalid_archive_cursor", 400)
			}
			at = r["created_at"]
			id = r["id"]
		} else {
			raw, e := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, "ac1."))
			var c archiveCursor
			var fields Object
			if !strings.HasPrefix(value, "ac1.") || e != nil || protocol.Decode(raw, &fields) != nil || len(fields) != 5 || protocol.Decode(raw, &c) != nil || c.Version != 1 || c.AccountID != a.AccountID || c.Origin != origin(a) || !validID(c.ID) {
				return nil, fault.New("invalid_archive_cursor", 400)
			}
			parsed, e := time.Parse("2006-01-02T15:04:05.000Z", c.CreatedAt)
			if e != nil || stamp(parsed) != c.CreatedAt {
				return nil, fault.New("invalid_archive_cursor", 400)
			}
			at = c.CreatedAt
			id = c.ID
		}
	}
	rr, e := rows(ctx, tx, `SELECT * FROM private_conversation_archives_v1 WHERE account_id=$1 AND (expires_at IS NULL OR expires_at>$2) AND ($3::text IS NULL OR origin_subject_id=$3) AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND id>$5::uuid)) ORDER BY created_at DESC,id LIMIT $6`, a.AccountID, s.now(), origin(a), at, id, limit+1)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	var next any
	for i, r := range rr {
		if int64(i) == limit {
			last := rr[i-1]
			next = "ac1." + base64.RawURLEncoding.EncodeToString(encoded(archiveCursor{1, a.AccountID, origin(a), date(last["created_at"]).(string), str(last, "id")}))
			break
		}
		out = append(out, archiveView(r))
	}
	return Object{"archives": out, "nextAfter": next}, nil
}
