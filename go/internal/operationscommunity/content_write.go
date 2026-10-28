package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"reflect"
	"sort"
	"strings"
	"unicode"
)

func (s *Service) contentEvent(ctx context.Context, tx pgx.Tx, a Actor, kind, id, eventKind, op string, source, revision int64, reason string, changes Object) error {
	_, e := tx.Exec(ctx, `INSERT INTO operations_forum_content_events_v1(id,endpoint,target_kind,target_id,kind,operator_id,operation_id,source_version,revision,reason,changes,http_request_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, uuid.NewString(), s.Endpoint, kind, id, eventKind, a.ID, op, source, revision, reason, encode(changes), a.RequestID, stamp(s.now()))
	return e
}
func (s *Service) contentVisibility(ctx context.Context, tx pgx.Tx, a Actor, kind, id string, x Object, batch bool) (Object, error) {
	v, e := s.contentView(ctx, tx, a, kind, id, true, true)
	if e != nil {
		return nil, e
	}
	if num(v, "version") != num(x, "expectedVersion") {
		return nil, fail("operations_source_changed", 409)
	}
	if num(obj(v, "visibility"), "version") != num(x, "expectedRevision") {
		return nil, fail("operations_visibility_changed", 409)
	}
	cap := "canHide"
	if str(x, "kind") == "restore" {
		cap = "canRestore"
	}
	if batch {
		cap = "canBatchHide"
		if str(x, "kind") == "restore" {
			cap = "canBatchRestore"
		}
	}
	if !yes(obj(v, "capabilities"), cap) {
		return nil, fail("operations_source_unavailable", 409)
	}
	input := copyObject(x)
	input["expectedVisibilityVersion"] = x["expectedRevision"]
	result, e := s.changeVisibility(ctx, tx, map[string]string{"post": "forum-post", "reply": "forum-reply"}[kind], id, num(v, "version"), input)
	if e != nil {
		return nil, e
	}
	visibility := obj(result, "visibility")
	e = s.contentEvent(ctx, tx, a, kind, id, "visibility", str(x, "operationId"), num(v, "version"), num(visibility, "version"), str(x, "reason"), Object{"kind": x["kind"], "hidden": visibility["hidden"], "until": visibility["until"]})
	return visibility, e
}
func (s *Service) ContentVisibility(ctx context.Context, a Actor, kind, id string, input Object) (Object, error) {
	x, e := parseContentWrite(input, "visibility")
	if e != nil {
		return nil, e
	}
	selection := copyObject(x)
	delete(selection, "reason")
	selection["targetKind"], selection["id"], selection["reasonDigest"] = kind, id, digest(str(x, "reason"))
	saved, e := s.domain().Command(ctx, a, "community-content-visibility", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		v, e := s.contentVisibility(ctx, tx, a, kind, id, x, false)
		return Object{"kind": kind, "id": id, "visibility": v}, e
	})
	if e != nil {
		return nil, e
	}
	result, e := s.Content(ctx, a, kind, id, Object{})
	if e != nil {
		return nil, e
	}
	result["operationId"], result["replayed"] = x["operationId"], yes(saved, "replayed")
	return result, nil
}
func (s *Service) Curate(ctx context.Context, a Actor, kind, id string, input Object) (Object, error) {
	x, e := parseContentWrite(input, "curation")
	if e != nil {
		return nil, e
	}
	selection := copyObject(x)
	delete(selection, "reason")
	selection["kind"], selection["id"], selection["reasonDigest"] = kind, id, digest(str(x, "reason"))
	saved, e := s.domain().Command(ctx, a, "community-content-curation", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		view, e := s.contentView(ctx, tx, a, kind, id, false, true)
		if e != nil {
			return nil, e
		}
		old := obj(view, "curation")
		if num(view, "version") != num(x, "expectedVersion") {
			return nil, fail("operations_source_changed", 409)
		}
		if num(old, "revision") != num(x, "expectedRevision") {
			return nil, fail("operations_curation_changed", 409)
		}
		if !yes(obj(view, "capabilities"), "canCurate") {
			return nil, fail("operations_source_unavailable", 409)
		}
		if !yes(old, "appliesToCurrent") {
			old = Object{"topic": nil, "pinned": false, "featured": false, "tagIds": []any{}}
		}
		topic, pinned, featured := old["topic"], old["pinned"], old["featured"]
		if v, ok := x["topic"]; ok {
			topic = v
		}
		if v, ok := x["pinned"]; ok {
			pinned = v
		}
		if v, ok := x["featured"]; ok {
			featured = v
		}
		raw := old["tagIds"]
		if v, ok := x["tagIds"]; ok {
			raw = v
		}
		ids := []string{}
		for _, v := range raw.([]any) {
			ids = append(ids, v.(string))
		}
		sort.Strings(ids)
		if len(ids) > 0 {
			var n int
			if e = tx.QueryRow(ctx, "SELECT count(*) FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]) AND enabled=true", s.Endpoint, ids).Scan(&n); e != nil {
				return nil, e
			}
			if n != len(ids) {
				return nil, fail("operations_tag_unavailable", 409)
			}
		}
		oldIDs := []string{}
		for _, v := range old["tagIds"].([]any) {
			oldIDs = append(oldIDs, v.(string))
		}
		sort.Strings(oldIDs)
		if yes(obj(view, "curation"), "appliesToCurrent") && topic == old["topic"] && pinned == old["pinned"] && featured == old["featured"] && reflect.DeepEqual(ids, oldIDs) {
			return nil, fail("operations_content_unchanged", 409)
		}
		revision := num(obj(view, "curation"), "revision") + 1
		_, e = tx.Exec(ctx, `INSERT INTO operations_forum_curation_v1(endpoint,target_kind,target_id,revision,source_version,topic,pinned,featured,tag_ids,operation_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(endpoint,target_kind,target_id) DO UPDATE SET revision=EXCLUDED.revision,source_version=EXCLUDED.source_version,topic=EXCLUDED.topic,pinned=EXCLUDED.pinned,featured=EXCLUDED.featured,tag_ids=EXCLUDED.tag_ids,operation_id=EXCLUDED.operation_id,updated_at=EXCLUDED.updated_at`, s.Endpoint, kind, id, revision, num(view, "version"), topic, pinned, featured, encode(ids), x["operationId"], stamp(s.now()))
		if e != nil {
			return nil, e
		}
		e = s.contentEvent(ctx, tx, a, kind, id, "curation", str(x, "operationId"), num(view, "version"), revision, str(x, "reason"), Object{"topic": topic, "pinned": pinned, "featured": featured, "tagIds": ids})
		return Object{"kind": kind, "id": id, "revision": revision, "sourceVersion": view["version"]}, e
	})
	if e != nil {
		return nil, e
	}
	result, e := s.Content(ctx, a, kind, id, Object{})
	if e != nil {
		return nil, e
	}
	result["operationId"], result["replayed"] = x["operationId"], yes(saved, "replayed")
	return result, nil
}
func (s *Service) Tag(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	creating := id == ""
	x, e := parseTag(input, creating)
	if e != nil || !creating && !validID(id) {
		return nil, invalid()
	}
	action := "community-tag-create"
	if !creating {
		action = "community-tag-update"
	}
	selection := Object{"operationId": x["operationId"], "expectedVersion": x["expectedVersion"], "nameDigest": nil, "enabled": x["enabled"]}
	if id != "" {
		selection["id"] = id
	}
	if x["name"] != nil {
		selection["nameDigest"] = digest(str(x, "name"))
	}
	result, e := s.domain().Command(ctx, a, action, selection, func(tx pgx.Tx, a Actor) (Object, error) {
		var old Object
		var e error
		if id != "" {
			old, e = one(ctx, tx, "SELECT to_jsonb(t) FROM operations_forum_tags_v1 t WHERE endpoint=$1 AND id=$2 FOR UPDATE", s.Endpoint, id)
			if e != nil {
				return nil, e
			}
			if old == nil {
				return nil, fail("not_found", 404)
			}
			if num(old, "revision") != num(x, "expectedVersion") {
				return nil, fail("operations_tag_changed", 409)
			}
		}
		name := str(x, "name")
		if x["name"] == nil {
			name = str(old, "name")
		}
		normalized := norm.NFKC.String(name)
		normalized = strings.Join(strings.FieldsFunc(normalized, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' }), " ")
		normalized = cases.Lower(language.AmericanEnglish).String(normalized)
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912398))", s.Endpoint+":forum-tag:"+normalized); e != nil {
			return nil, e
		}
		var exists bool
		var nullable any
		if id != "" {
			nullable = id
		}
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_forum_tags_v1 WHERE endpoint=$1 AND normalized_name=$2 AND ($3::uuid IS NULL OR id<>$3))", s.Endpoint, normalized, nullable).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fail("operations_tag_exists", 409)
		}
		enabled := true
		if old != nil {
			enabled = yes(old, "enabled")
		}
		if v, ok := x["enabled"]; ok {
			enabled = v.(bool)
		}
		tagID := id
		created := stamp(s.now())
		if tagID == "" {
			tagID = uuid.NewString()
		} else {
			created = jsDate(old["created_at"])
		}
		revision := num(old, "revision") + 1
		r, e := one(ctx, tx, `INSERT INTO operations_forum_tags_v1(id,endpoint,name,normalized_name,revision,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,normalized_name=EXCLUDED.normalized_name,revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at RETURNING to_jsonb(operations_forum_tags_v1)`, tagID, s.Endpoint, name, normalized, revision, enabled, created, stamp(s.now()))
		if e != nil {
			return nil, e
		}
		eventKind := "tag-create"
		if !creating {
			eventKind = "tag-update"
		}
		e = s.contentEvent(ctx, tx, a, "tag", tagID, eventKind, str(x, "operationId"), revision, revision, "", Object{"name": name, "enabled": enabled})
		return Object{"tag": tagView(r)}, e
	})
	if e != nil {
		return nil, e
	}
	result["replayed"] = yes(result, "replayed")
	return result, nil
}
func (s *Service) Preview(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := parseBatch(input, true)
	if e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-content-batch-preview", Object{"kind": x["kind"], "count": len(x["items"].([]any))}, func(tx pgx.Tx, a Actor) (Object, error) {
		items := []Object{}
		for _, value := range x["items"].([]any) {
			item := value.(map[string]any)
			var title, code any
			view, e := s.contentView(ctx, tx, a, str(item, "kind"), str(item, "id"), false, false)
			if e != nil {
				if !hasStatus(e, 403, 404, 409) {
					return nil, e
				}
				code = fault.Code(e)
			} else {
				title = view["title"]
				switch {
				case num(view, "version") != num(item, "expectedVersion"):
					code = "operations_source_changed"
				case num(obj(view, "visibility"), "version") != num(item, "expectedRevision"):
					code = "operations_visibility_changed"
				default:
					cap := "canBatchHide"
					if str(x, "kind") == "restore" {
						cap = "canBatchRestore"
					}
					if !yes(obj(view, "capabilities"), cap) {
						code = "operations_source_unavailable"
					} else if str(x, "kind") == "hide" && (num(x, "until") <= s.now() || num(x, "until") > s.now()+num(s.policy(), "maxGovernanceHideSeconds")) {
						code = "operations_hide_expiry"
					}
				}
			}
			v := copyObject(item)
			v["title"], v["eligible"], v["reason"] = title, code == nil, code
			items = append(items, v)
		}
		return Object{"items": items, "checkedAt": s.now(), "maximumItems": 25}, nil
	})
}
func hasStatus(e error, status ...int) bool {
	for _, v := range status {
		if fault.Status(e) == v {
			return true
		}
	}
	return false
}
func (s *Service) Batch(ctx context.Context, a Actor, input Object) (Object, error) {
	x, e := parseBatch(input, false)
	if e != nil {
		return nil, e
	}
	selection := copyObject(x)
	delete(selection, "reason")
	selection["reasonDigest"] = digest(str(x, "reason"))
	result, e := s.domain().Command(ctx, a, "community-content-batch-visibility", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		items := []Object{}
		for _, v := range x["items"].([]any) {
			items = append(items, v.(map[string]any))
		}
		sort.Slice(items, func(i, j int) bool {
			return str(items[i], "kind")+":"+str(items[i], "id") < str(items[j], "kind")+":"+str(items[j], "id")
		})
		byKey := map[string]Object{}
		applied := 0
		for _, item := range items {
			if _, e = tx.Exec(ctx, "SAVEPOINT content_item"); e != nil {
				return nil, e
			}
			command := copyObject(x)
			for k, v := range item {
				if k != "kind" {
					command[k] = v
				}
			}
			v, e := s.contentVisibility(ctx, tx, a, str(item, "kind"), str(item, "id"), command, true)
			var out Object
			if e != nil {
				if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT content_item"); err != nil {
					return nil, err
				}
				if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT content_item"); err != nil {
					return nil, err
				}
				if !hasStatus(e, 400, 403, 404, 409) {
					return nil, e
				}
				out = Object{"kind": item["kind"], "id": item["id"], "status": "rejected", "code": fault.Code(e)}
			} else {
				if _, e = tx.Exec(ctx, "RELEASE SAVEPOINT content_item"); e != nil {
					return nil, e
				}
				applied++
				out = Object{"kind": item["kind"], "id": item["id"], "status": "applied", "code": nil, "visibility": v}
			}
			byKey[str(item, "kind")+":"+str(item, "id")] = out
		}
		out := []Object{}
		for _, v := range x["items"].([]any) {
			item := v.(map[string]any)
			out = append(out, byKey[str(item, "kind")+":"+str(item, "id")])
		}
		return Object{"items": out, "counts": Object{"applied": applied, "rejected": len(items) - applied}}, nil
	})
	if e != nil {
		return nil, e
	}
	result["replayed"] = yes(result, "replayed")
	return result, nil
}
