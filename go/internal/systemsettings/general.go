package systemsettings

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publication"
	"github.com/jackc/pgx/v5"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type General struct {
	Settings      *Service
	Publications  *publication.Commands
	WebsiteOrigin string
	Client        *http.Client
}

func (g *General) PublishedGeneral(ctx context.Context, a Actor) (Object, error) {
	if _, e := g.Settings.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	result := Object{"publication": Object{"id": nil, "state": "unavailable"}, "configuration": nil}
	if id, e := g.marker(ctx); e == nil {
		if row, e := optional(ctx, g.Settings.Pool, `SELECT to_jsonb(p) FROM(SELECT snapshot FROM site_publications_v1 WHERE id=$1 AND endpoint=$2)p`, id, g.Settings.Endpoint); e == nil && row != nil {
			if settings, e := publication.ParseSettings(obj(obj(row["snapshot"])["settings"])); e == nil {
				if again, e := g.marker(ctx); e == nil && again == id {
					result = Object{"publication": Object{"id": id, "state": "available"}, "configuration": settings}
				}
			}
		}
	}
	if _, e := g.Settings.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	result["basis"] = "current-public-website-publication"
	result["savedDraft"] = Object{"state": "not-read", "configuration": nil}
	return g.Settings.stamp(result), nil
}

func (g *General) Validate() error {
	u, e := whatwg.Parse(g.WebsiteOrigin)
	if e != nil || u.Scheme() != "https" || u.Username() != "" || u.Password() != "" || u.Scheme()+"://"+u.Host() != g.WebsiteOrigin {
		return invalid()
	}
	return nil
}
func (g *General) marker(ctx context.Context) (any, error) {
	if e := g.Validate(); e != nil {
		return nil, fail("system_settings_source_changed", 503)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return fail("system_settings_source_changed", 503) }}
	if g.Client != nil {
		client.Transport, client.Timeout = g.Client.Transport, g.Client.Timeout
	}
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	if native, ok := transport.(*http.Transport); ok {
		copy := native.Clone()
		copy.Proxy = nil
		transport = copy
	}
	client.Transport = transport
	req, e := http.NewRequestWithContext(ctx, "GET", g.WebsiteOrigin+"/site-publication.json", nil)
	if e != nil {
		return nil, fail("system_settings_source_changed", 503)
	}
	req.Header.Set("Cache-Control", "no-cache")
	res, e := client.Do(req)
	if e != nil {
		return nil, fail("system_settings_source_changed", 503)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fail("system_settings_source_changed", 503)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, 4097))
	if e != nil || len(b) > 4096 {
		return nil, fail("system_settings_source_changed", 503)
	}
	var value Object
	if json.Unmarshal(b, &value) != nil || !whole(value["version"], 1, 1) {
		return nil, fail("system_settings_source_changed", 503)
	}
	if id, ok := value["publicationId"]; ok && id == nil {
		return nil, nil
	}
	id, ok := parseUUID(value["publicationId"], true)
	if !ok {
		return nil, fail("system_settings_source_changed", 503)
	}
	return id, nil
}
func (g *General) Source(ctx context.Context, a Actor) (Object, error) {
	if _, e := g.Settings.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	var id any
	state := "unavailable"
	if current, e := g.marker(ctx); e == nil {
		row, e := optional(ctx, g.Settings.Pool, `SELECT to_jsonb(p) FROM(SELECT id FROM site_publications_v1 WHERE id=$1 AND endpoint=$2)p`, current, g.Settings.Endpoint)
		if e == nil && row != nil {
			id = current
			state = "available"
		}
	}
	if _, e := g.Settings.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	return g.Settings.stamp(Object{"publication": Object{"id": id, "state": state}}), nil
}
func safeHref(v any) bool {
	s, ok := v.(string)
	if !ok || utf8.RuneCountInString(s) > 2048 || strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || trim(string(r)) == "" || r == '\\' }) {
		return false
	}
	if strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") {
		return true
	}
	u, e := whatwg.Parse(s)
	return e == nil && u.Scheme() == "https" && u.Username() == "" && u.Password() == ""
}
func ParseGeneralConfiguration(input Object) (Object, error) {
	if !closed(input, []string{"siteTitle", "description", "footerLinks"}, nil) {
		return nil, invalid()
	}
	x := clone(input)
	validText := func(key string, min, max int) bool {
		if !parseText(x, key, min, max, true) {
			return false
		}
		return !strings.ContainsFunc(str(x[key]), func(r rune) bool { return r <= 8 || r == 11 || r == 12 || r >= 14 && r <= 31 })
	}
	if !validText("siteTitle", 1, 120) || !validText("description", 0, 600) {
		return nil, invalid()
	}
	links, ok := x["footerLinks"].([]any)
	if !ok || len(links) > 12 {
		return nil, invalid()
	}
	normalized := []any{}
	for _, v := range links {
		r := clone(obj(v))
		if !closed(r, []string{"label", "href"}, nil) || !parseText(r, "label", 1, 100, true) || strings.ContainsFunc(str(r["label"]), func(c rune) bool { return c <= 8 || c == 11 || c == 12 || c >= 14 && c <= 31 }) || !safeHref(r["href"]) {
			return nil, invalid()
		}
		normalized = append(normalized, r)
	}
	x["footerLinks"] = normalized
	return x, nil
}
func ParseGeneralPublish(input Object) (Object, error) {
	if !closed(input, []string{"operationId", "expectedPublicationId", "settingsRevision", "versionId", "settings"}, nil) {
		return nil, invalid()
	}
	x := clone(input)
	for _, k := range []string{"operationId", "expectedPublicationId", "versionId"} {
		if !setUUID(x, k, true) {
			return nil, invalid()
		}
	}
	if !whole(x["settingsRevision"], 0, 2147483646) {
		return nil, invalid()
	}
	settings, e := ParseGeneralConfiguration(obj(x["settings"]))
	if e != nil {
		return nil, e
	}
	x["settings"] = settings
	return x, nil
}

// Only this controller's validated base snapshot plus settings replacement can
// obtain the original system-settings publication purpose. It is not a CMS API.
type generalPublicationAuthority struct {
	g     *General
	actor Actor
}

func (a *generalPublicationAuthority) Account(context.Context, pgx.Tx, string, string) error {
	return fail("system_settings_permission_denied", 403)
}
func (a *generalPublicationAuthority) Operator(ctx context.Context, tx pgx.Tx, endpoint, id, permission string) (feedback.Operator, error) {
	if endpoint != a.g.Settings.Endpoint || id != a.actor.ID {
		return feedback.Operator{}, fail("system_settings_permission_denied", 403)
	}
	action := ""
	if permission == "cms.publish" {
		action = "system.settings.apply"
	} else if permission == "cms.read" {
		action = "system.settings.read"
	} else {
		return feedback.Operator{}, fail("system_settings_permission_denied", 403)
	}
	actor, e := a.g.Settings.require(ctx, tx, a.actor, action)
	if e != nil {
		return feedback.Operator{}, e
	}
	requestID := ""
	if actor.RequestID != nil {
		requestID = *actor.RequestID
	}
	return feedback.Operator{ID: actor.ID, Role: actor.Role, RequestID: requestID, CanManage: true}, nil
}
func (g *General) Publish(ctx context.Context, a Actor, input Object, authorize func() (Actor, error)) (Object, error) {
	x, e := ParseGeneralPublish(input)
	if e != nil {
		return nil, e
	}
	if _, e = g.Settings.freshOutside(ctx, a, "system.settings.apply", authorize); e != nil {
		return nil, e
	}
	prior, e := optional(ctx, g.Settings.Pool, `SELECT to_jsonb(p) FROM operations_system_general_publications_v1 p WHERE endpoint=$1 AND operation_id=$2`, g.Settings.Endpoint, x["operationId"])
	if e != nil {
		return nil, e
	}
	if prior != nil {
		if prior["operator_id"] != a.ID || !same(prior["input"], x) {
			return nil, fail("system_settings_operation_changed", 409)
		}
		return g.Operation(ctx, a, str(x["operationId"]))
	}
	current, e := g.marker(ctx)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, g.Settings.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912465))`, g.Settings.Endpoint); e != nil {
			return nil, e
		}
		actor, e := g.Settings.fresh(ctx, tx, a, "system.settings.apply", authorize)
		if e != nil {
			return nil, e
		}
		old, e := optional(ctx, tx, `SELECT to_jsonb(p) FROM operations_system_general_publications_v1 p WHERE endpoint=$1 AND operation_id=$2`, g.Settings.Endpoint, x["operationId"])
		if e != nil {
			return nil, e
		}
		if old != nil {
			if old["operator_id"] != actor.ID || !same(old["input"], x) {
				return nil, fail("system_settings_operation_changed", 409)
			}
			return g.result(ctx, tx, old, nil)
		}
		base, e := optional(ctx, tx, `SELECT to_jsonb(p) FROM(SELECT snapshot FROM site_publications_v1 WHERE endpoint=$1 AND id=$2)p`, g.Settings.Endpoint, x["expectedPublicationId"])
		if e != nil {
			return nil, e
		}
		if current != x["expectedPublicationId"] || base == nil {
			failed, e := one(ctx, tx, `INSERT INTO operations_system_general_publications_v1(endpoint,operation_id,operator_id,input,publication_id,result,created_at) VALUES($1,$2,$3,$4,NULL,$5,$6) RETURNING to_jsonb(operations_system_general_publications_v1)`, g.Settings.Endpoint, x["operationId"], actor.ID, x, Object{"code": "system_settings_source_changed"}, g.Settings.now())
			if e != nil {
				return nil, e
			}
			if _, e = g.Settings.fresh(ctx, tx, a, "system.settings.apply", authorize); e != nil {
				return nil, e
			}
			return g.result(ctx, tx, failed, nil)
		}
		snapshot := clone(obj(base["snapshot"]))
		snapshot["settings"] = x["settings"]
		raw, e := protocol.EncodeJS(Object{"operationId": x["operationId"], "snapshot": snapshot})
		if e != nil {
			return nil, e
		}
		if g.Publications == nil {
			return nil, fail("site_publication_queue_unavailable", 503)
		}
		scoped := *g.Publications
		scoped.Authority = &generalPublicationAuthority{g: g, actor: actor}
		requested, e := scoped.RequestWithin(ctx, tx, actor.ID, raw)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE site_publications_v1 SET base_publication_id=$3 WHERE endpoint=$1 AND id=$2`, g.Settings.Endpoint, x["operationId"], x["expectedPublicationId"]); e != nil {
			return nil, e
		}
		row, e := one(ctx, tx, `INSERT INTO operations_system_general_publications_v1(endpoint,operation_id,operator_id,input,publication_id,created_at) VALUES($1,$2,$3,$4,$2,$5) RETURNING to_jsonb(operations_system_general_publications_v1)`, g.Settings.Endpoint, x["operationId"], actor.ID, x, g.Settings.now())
		if e != nil {
			return nil, e
		}
		if _, e = g.Settings.fresh(ctx, tx, a, "system.settings.apply", authorize); e != nil {
			return nil, e
		}
		return g.result(ctx, tx, row, obj(requested["publication"]))
	})
}
func (g *General) result(ctx context.Context, q Reader, row, supplied Object) (Object, error) {
	publication := supplied
	if publication == nil && row["publication_id"] != nil {
		var e error
		publication, e = optional(ctx, q, `SELECT to_jsonb(p) FROM(SELECT state,error,created_at,updated_at FROM site_publications_v1 WHERE endpoint=$1 AND id=$2)p`, g.Settings.Endpoint, row["publication_id"])
		if e != nil {
			return nil, e
		}
	}
	var code any
	if obj(row["result"])["code"] == "system_settings_source_changed" || obj(publication["error"])["code"] == "site_publication_base_changed" {
		code = "system_settings_source_changed"
	}
	state := "unknown"
	if code != nil {
		state = "failed"
	} else if publication["state"] == "published" {
		state = "completed"
	} else if publication["state"] == "failed" {
		state = "failed"
	} else if publication != nil {
		state = "accepted"
	}
	phaseState := state
	if state == "accepted" {
		phaseState = "running"
	}
	var adopted, finished any
	if state == "completed" {
		adopted = obj(row["input"])["versionId"]
	}
	if state == "completed" || state == "failed" {
		at := publication["updated_at"]
		if at == nil {
			at = publication["updatedAt"]
		}
		if at == nil {
			at = row["created_at"]
		}
		finished = iso(at)
	}
	operation := Object{"operationId": row["operation_id"], "section": "general", "kind": "apply", "state": state, "versionId": obj(row["input"])["versionId"], "revision": obj(row["input"])["settingsRevision"], "phases": []any{Object{"target": "public-website", "state": phaseState, "code": code, "adoptedVersionId": adopted}}, "startedAt": iso(row["created_at"]), "finishedAt": finished}
	return g.Settings.stamp(Object{"state": "recorded", "operationId": row["operation_id"], "operation": operation}), nil
}
func (g *General) Operation(ctx context.Context, a Actor, id string) (Object, error) {
	id, ok := parseUUID(id, true)
	if !ok {
		return nil, invalid()
	}
	if _, e := g.Settings.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	row, e := optional(ctx, g.Settings.Pool, `SELECT to_jsonb(p) FROM operations_system_general_publications_v1 p WHERE endpoint=$1 AND operation_id=$2`, g.Settings.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if row != nil && row["operator_id"] != a.ID {
		return nil, fail("system_settings_permission_denied", 403)
	}
	result := g.Settings.stamp(Object{"state": "not-recorded", "operationId": id, "operation": nil})
	if row != nil {
		result, e = g.result(ctx, g.Settings.Pool, row, nil)
		if e != nil {
			return nil, e
		}
	}
	if _, e = g.Settings.current(ctx, a, "system.settings.read"); e != nil {
		return nil, e
	}
	return result, nil
}
