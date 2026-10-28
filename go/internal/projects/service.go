// Package projects owns current signed project document, role and wish reads.
// The existing contact/discovery consumer uses these same domain readers;
// current read permission never grants editing, contact or work participation.
package projects

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"regexp"
	"sync"
	"time"
)

type Object = map[string]any

var projectListAfter = regexp.MustCompile(`(?i)^[a-f0-9-]{36}$`)

type Service struct {
	Pool                 *pgxpool.Pool
	Endpoint             string
	Devices              *deviceauth.Service
	Links                *accountlinks.Service
	Profiles             *profiles.Service
	Resources            *resourcebudget.Service
	Now                  func() time.Time
	DiscoveryPreferences func(context.Context, pgx.Tx, string) (Object, error)
	cursorOnce           sync.Once
	cursorKey            []byte
	cursorError          error
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func fail(code string, status int) error { return fault.New(code, status) }
func str(o Object, k string) string      { v, _ := o[k].(string); return v }
func obj(o Object, k string) Object      { v, _ := o[k].(map[string]any); return v }
func num(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}
func truth(o Object, k string) bool { v, _ := o[k].(bool); return v }
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var out Object
	e = json.Unmarshal(raw, &out)
	return out, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rr, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	out := []Object{}
	for rr.Next() {
		var raw []byte
		if e = rr.Scan(&raw); e != nil {
			return nil, e
		}
		var r Object
		if e = json.Unmarshal(raw, &r); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rr.Err()
}
func (s *Service) grant(ctx context.Context, tx pgx.Tx, event Object) (deviceauth.ConsentIntent, error) {
	if event == nil || str(event, "payload_text") == "" {
		return deviceauth.ConsentIntent{}, fail("project_source_unavailable", 404)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fail("project_service_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), Action: "project.write", ObjectID: str(event, "operation_id"), Recipient: s.Endpoint, PayloadJSON: str(event, "payload_text")})
}
func (s *Service) canRead(v deviceauth.ConsentIntent, viewer string) bool {
	if v.IssuedAt > s.now() || v.ExpiresAt <= s.now() {
		return false
	}
	if viewer == v.SubjectID {
		return true
	}
	if v.CurrentVisibility != nil && v.CurrentVisibility.DeletionPending {
		return false
	}
	if v.Visibility == "Public" {
		return v.Purpose == "public-profile"
	}
	return v.Visibility == "Private" && viewer != "" && contains(v.Viewers, viewer)
}

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func (s *Service) project(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fail("invalid_project_request", 400)
	}
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM projects_v2 p WHERE id=$1"+lock, id)
	if e != nil {
		return nil, e
	}
	if p == nil {
		return nil, fail("project_not_found", 404)
	}
	return p, nil
}
func (s *Service) RolesWithin(ctx context.Context, tx pgx.Tx, p Object, subject string) ([]string, error) {
	if str(p, "owner_id") == subject {
		return []string{"owner"}, nil
	}
	rr, e := rows(ctx, tx, `SELECT to_jsonb(e)||jsonb_build_object('role',r.role) FROM project_roles_v2 r JOIN project_events_v2 e ON e.operation_id=r.grant_event_id WHERE r.project_id=$1 AND r.subject_id=$2 AND r.state='active'`, p["id"], subject)
	if e != nil {
		return nil, e
	}
	out := []string{}
	for _, r := range rr {
		if _, e = s.grant(ctx, tx, r); e != nil {
			if fault.Status(e) == 403 || fault.Status(e) == 404 {
				continue
			}
			return nil, e
		}
		out = append(out, str(r, "role"))
	}
	return out, nil
}
func (s *Service) operations(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(o) FROM operations_content_visibility_v1 o WHERE endpoint=$1 AND target_kind='project' AND target_id=$2", s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return Object{"version": 0, "hidden": false, "until": nil, "operationId": nil}, nil
	}
	var until any
	if r["hidden_until"] != nil {
		t, _ := time.Parse(time.RFC3339Nano, str(r, "hidden_until"))
		until = t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	hidden := false
	if until != nil {
		t, _ := time.Parse(time.RFC3339Nano, str(r, "hidden_until"))
		hidden = t.After(time.Unix(s.now(), 0))
	}
	return Object{"hidden": hidden, "until": until, "version": r["revision"], "operationId": r["operation_id"]}, nil
}
func (s *Service) DocumentWithin(ctx context.Context, tx pgx.Tx, viewer string, p Object, allowPartial bool) (Object, error) {
	rr, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM project_events_v2 e WHERE project_id=$1 AND kind IN ('create','revise') ORDER BY revision", p["id"])
	if e != nil {
		return nil, e
	}
	order := []string{}
	fields, sources := Object{}, map[string]Object{}
	assign := func(key string, value any, source Object) {
		if _, ok := sources[key]; !ok {
			order = append(order, key)
		}
		fields[key], sources[key] = value, source
	}
	for _, r := range rr {
		if str(r, "payload_text") == "" {
			affected, _ := r["affected_fields"].([]any)
			for _, field := range affected {
				key, _ := field.(string)
				assign(key, nil, r)
			}
			continue
		}
		event, e := ParseEvent([]byte(str(r, "payload_text")))
		if e != nil {
			return nil, e
		}
		values := obj(event, "patch")
		if str(event, "kind") == "create" {
			values = obj(event, "document")
		}
		for _, key := range orderedKeys([]byte(str(r, "payload_text")), str(event, "kind") == "create") {
			value, exists := values[key]
			if !exists {
				continue
			}
			if key == "sourceUrl" && value == nil {
				delete(fields, key)
				delete(sources, key)
				next := []string{}
				for _, old := range order {
					if old != key {
						next = append(next, old)
					}
				}
				order = next
			} else {
				assign(key, value, r)
			}
		}
	}
	visible := Object{}
	outSources := []Object{}
	checked := map[string]bool{}
	known := map[string]bool{}
	for _, key := range order {
		source := sources[key]
		if source == nil {
			continue
		}
		operation := str(source, "operation_id")
		if !known[operation] {
			known[operation] = true
			grant, e := s.grant(ctx, tx, source)
			if e != nil {
				if fault.Status(e) != 403 && fault.Status(e) != 404 {
					return nil, e
				}
			} else {
				checked[operation] = s.canRead(grant, viewer)
			}
		}
		if checked[operation] {
			visible[key] = fields[key]
			outSources = append(outSources, Object{"field": key, "operationId": source["operation_id"], "subjectId": source["subject_id"]})
		}
	}
	document, e := ParseDocument(visible, false)
	if e != nil {
		if !allowPartial {
			return nil, fail("project_source_unavailable", 404)
		}
		document = visible
	}
	return Object{"document": document, "fields": outSources}, nil
}

// ReadForContactWithin is called only after the contact consumer has proved the
// initiator from its current signed context; it never fabricates their session.
func (s *Service) ReadForContactWithin(ctx context.Context, tx pgx.Tx, viewer, projectID string) (Object, error) {
	return s.readWithin(ctx, tx, viewer, projectID, false, false)
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	viewer := ""
	if a != nil {
		if s.Devices == nil {
			return nil, fail("project_service_unavailable", 503)
		}
		if e := s.Devices.AuthorizeWithin(ctx, tx, *a, "history"); e != nil {
			return nil, e
		}
		viewer = a.SubjectID
	}
	return s.readWithin(ctx, tx, viewer, id, false, false)
}
func (s *Service) readWithin(ctx context.Context, tx pgx.Tx, viewer, id string, includeArchived, ignoreOperations bool) (Object, error) {
	p, e := s.project(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	if str(p, "state") != "active" && !(includeArchived && str(p, "owner_id") == viewer) {
		return nil, fail("project_not_found", 404)
	}
	policy, e := row(ctx, tx, "SELECT to_jsonb(e) FROM project_events_v2 e WHERE operation_id=$1", p["policy_event_id"])
	if e != nil {
		return nil, e
	}
	grant, e := s.grant(ctx, tx, policy)
	if e != nil {
		return nil, e
	}
	if !s.canRead(grant, viewer) {
		return nil, fail("project_not_found", 404)
	}
	roles := []string{}
	if viewer != "" {
		roles, e = s.RolesWithin(ctx, tx, p, viewer)
		if e != nil {
			return nil, e
		}
	}
	operations, e := s.operations(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	if truth(operations, "hidden") && !ignoreOperations && len(roles) == 0 {
		return nil, fail("project_not_found", 404)
	}
	material, e := s.DocumentWithin(ctx, tx, viewer, p, false)
	if e != nil {
		return nil, e
	}
	canRole := func(values ...string) bool {
		for _, role := range values {
			if contains(roles, role) {
				return true
			}
		}
		return false
	}
	out := Object{"schemaVersion": 2, "projectId": id, "ownerId": p["owner_id"], "creatorId": p["creator_id"], "revision": p["revision"], "state": p["state"], "document": material["document"], "visibility": grant.Visibility, "classification": "self-declared", "capabilityVerified": false, "legalOwnershipVerified": false, "source": Object{"documentEventId": p["document_event_id"], "policyEventId": p["policy_event_id"], "sourceStatementId": p["source_statement_id"], "fieldSources": material["fields"]}, "ownRoles": roles, "permissions": Object{"edit": canRole("owner", "editor"), "represent": canRole("owner", "representative"), "manage": canRole("owner"), "privateFiles": false, "agentControl": false}}
	if len(roles) > 0 {
		out["operationsVisibility"] = operations
	}
	return out, nil
}
