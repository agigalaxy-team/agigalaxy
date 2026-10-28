package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) reports(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) ([]any, error) {
	out := []any{}
	if s.Builders == nil {
		return out, nil
	}
	view, e := s.Builders.SupportWithin(ctx, tx, a, Object{"builderId": id})
	if e != nil {
		if domain(e) {
			return out, nil
		}
		return nil, e
	}
	rows, e := query(ctx, tx, "SELECT * FROM builder_events WHERE builder_id=$1 AND kind='scope-report'", id)
	if e != nil {
		return nil, e
	}
	for _, raw := range arr(view["reports"]) {
		report := obj(raw)
		var row Object
		for _, r := range rows {
			if r["id"] == report["id"] {
				row = r
				break
			}
		}
		if row == nil {
			continue
		}
		public, e := s.Builders.EventPermittedWithin(ctx, tx, nil, row)
		if e != nil {
			return nil, e
		}
		report = clone(report)
		report["payloadHash"] = row["payload_hash"]
		report["publiclyReadable"] = public
		report["canReferenceInCharter"] = obj(view["disclosure"])["visibility"] != "Public" || public
		out = append(out, report)
	}
	return out, nil
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	head, e := s.head(ctx, tx, txt(input, "hubId"), false)
	if e != nil {
		return nil, e
	}
	charter, e := s.charter(ctx, tx, a, head, input["version"])
	if e != nil {
		return nil, e
	}
	payload := event(charter)
	state := head["state"]
	reports := []any{}
	readable := false
	b, e := s.registry(ctx, tx, a, txt(head, "id"))
	if e != nil {
		if !domain(e) {
			return nil, e
		}
		state = "declaration-unavailable"
	} else {
		readable = true
		if b.DeclarationEvent["id"] != payload["declarationId"] || b.DeclarationEvent["payload_hash"] != payload["declarationHash"] {
			state = "declaration-changed"
		}
		if b.Maintenance["delisted"] == true || b.Maintenance["securityIssue"] == true {
			state = "builder-unavailable"
		}
		reports, e = s.reports(ctx, tx, a, txt(head, "id"))
		if e != nil {
			return nil, e
		}
	}
	claims := Object{}
	for key, raw := range obj(payload["charter"]) {
		v := obj(raw)
		if v == nil || v["status"] == nil {
			continue
		}
		clause := clone(v)
		ref := obj(v["reportRef"])
		var report Object
		for _, r := range reports {
			if obj(r)["id"] == ref["eventId"] {
				report = obj(r)
				break
			}
		}
		claimState := v["status"]
		if claimState == "reported-tested" {
			claimState = "report-unavailable"
			if report != nil && report["validity"] == "current" && report["payloadHash"] == ref["payloadHash"] {
				for _, check := range arr(report["checks"]) {
					if obj(check)["action"] == ref["action"] {
						claimState = "reported-" + txt(obj(check), "status")
						break
					}
				}
			}
		}
		clause["currentState"] = claimState
		clause["capabilityVerified"] = false
		if report != nil {
			clause["reportAuthority"] = report["authority"]
			clause["independentExecutionVerified"] = false
		}
		claims[key] = clause
	}
	owner := a != nil && a.SubjectID == head["owner_id"]
	currentCharter := num(charter, "charter_version") == num(head, "version")
	actions := []any{}
	if owner {
		if readable && num(head, "version") < 1000 {
			actions = append(actions, "charter")
		}
		if head["state"] == "active" {
			actions = append(actions, "suspend")
		} else if currentCharter && readable {
			actions = append(actions, "resume")
		}
		if currentCharter && state == "active" {
			actions = append(actions, "invite", "peer-approve")
		}
	} else if a != nil && currentCharter {
		actions = append(actions, "intake-open")
	}
	if a != nil && currentCharter && state == "active" {
		permitted := owner
		if !permitted {
			m, e := one(ctx, tx, "SELECT id FROM hub_memberships_v2 WHERE hub_id=$1 AND subject_id=$2 AND state='active'", head["id"], a.SubjectID)
			if e != nil {
				return nil, e
			}
			if m != nil {
				v, e := s.membership(ctx, tx, *a, head, txt(m, "id"))
				if e != nil {
					return nil, e
				}
				permitted = v["authorization"] == "active" && has(arr(v["scopes"]), "approved-proof-query")
			}
		}
		if permitted {
			actions = append(actions, "peering-query", "peering-share")
		}
	}
	if !currentCharter {
		state = "historical-version"
	}
	return flag(Object{"hubId": head["id"], "ownerId": head["owner_id"], "version": charter["charter_version"], "latestVersion": head["version"], "operationalState": head["state"], "availableActions": actions, "reports": reports, "state": state, "charter": payload["charter"], "claims": claims, "charterEventId": charter["id"], "charterHash": charter["payload_hash"], "declarationId": payload["declarationId"], "declarationHash": payload["declarationHash"], "checkedAt": s.now()}), nil
}
func (s *Service) Get(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("hubReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, a, in)
	})
}
func (s *Service) Manage(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("hubReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if s.Builders == nil {
			return nil, fault.New("hub_builder_unavailable", 503)
		}
		decl, e := s.Builders.ManagementWithin(ctx, tx, a, txt(in, "hubId"))
		if e != nil {
			return nil, e
		}
		head, e := one(ctx, tx, "SELECT * FROM hub_heads_v2 WHERE id=$1", in["hubId"])
		if e != nil {
			return nil, e
		}
		var current Object
		if head != nil {
			current, e = s.ReadWithin(ctx, tx, &a, Object{"hubId": in["hubId"]})
			if e != nil && !domain(e) {
				return nil, e
			}
		}
		actions := arr(current["availableActions"])
		var reports []any
		if current != nil {
			reports = arr(current["reports"])
		} else {
			actions = []any{}
			if decl["type"] == "hub" && decl["declarationState"] == "readable" && (head == nil || num(head, "version") < 1000) {
				actions = append(actions, "charter")
			}
			if head["state"] == "active" {
				actions = append(actions, "suspend")
			}
			reports, e = s.reports(ctx, tx, &a, txt(in, "hubId"))
			if e != nil {
				return nil, e
			}
		}
		state := head["state"]
		if state == nil {
			state = "charter-not-created"
		}
		return flag(Object{"hubId": in["hubId"], "ownerId": a.SubjectID, "latestVersion": num(head, "version"), "state": state, "current": current, "declaration": decl, "availableActions": actions, "reports": reports}), nil
	})
}
func cursor(rows []Object, limit int64) any {
	if int64(len(rows)) > limit {
		return rows[limit-1]["id"]
	}
	return nil
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("hubQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	if in["view"] != "public" && a == nil {
		return nil, fault.New("identity_required", 401)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var subject any
		if a != nil {
			subject = a.SubjectID
		}
		limit := num(in, "limit")
		rows, e := query(ctx, tx, `SELECT h.id FROM hub_heads_v2 h WHERE ($1::uuid IS NULL OR h.id>$1) AND ($2='public' OR $2='owned' AND h.owner_id=$3 OR $2='joined' AND EXISTS(SELECT 1 FROM hub_memberships_v2 m WHERE m.hub_id=h.id AND m.subject_id=$3)) ORDER BY h.id LIMIT $4`, in["after"], in["view"], subject, limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for i, row := range rows {
			if int64(i) >= limit {
				break
			}
			viewer := a
			if in["view"] == "public" {
				viewer = nil
			}
			v, e := s.ReadWithin(ctx, tx, viewer, Object{"hubId": row["id"]})
			if e != nil {
				if !domain(e) {
					return nil, e
				}
				continue
			}
			items = append(items, v)
		}
		return flag(Object{"items": items, "nextCursor": cursor(rows, limit), "coverage": "current-authorized-charters"}), nil
	})
}
func (s *Service) membership(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, head Object, id string) (Object, error) {
	m, e := one(ctx, tx, "SELECT * FROM hub_memberships_v2 WHERE id=$1 AND hub_id=$2 FOR SHARE", id, head["id"])
	if e != nil {
		return nil, e
	}
	if m == nil || (a.SubjectID != m["subject_id"] && a.SubjectID != head["owner_id"]) {
		return nil, unavailable()
	}
	invite, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE id=$1", m["invite_id"])
	if e != nil {
		return nil, e
	}
	valid, e := s.readable(ctx, tx, &a, invite)
	if e != nil {
		return nil, e
	}
	decisionValid := false
	if m["decision_id"] != nil {
		d, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE id=$1", m["decision_id"])
		if e != nil {
			return nil, e
		}
		decisionValid, e = s.readable(ctx, tx, &a, d)
		if e != nil {
			return nil, e
		}
	}
	scopes := []any{}
	if valid {
		scopes = arr(m["scopes"])
	}
	out := flag(Object{"membershipId": m["id"], "hubId": m["hub_id"], "memberId": m["subject_id"], "version": m["version"], "charterVersion": m["charter_version"], "state": m["state"], "expiresAt": m["expires_at"], "scopes": scopes, "availableActions": []any{}})
	if has([]any{"declined", "exited", "removed"}, m["state"]) {
		out["authorization"] = "inactive"
		return out, nil
	}
	current := false
	if _, _, e = s.current(ctx, tx, &a, txt(head, "id")); e != nil {
		if !domain(e) {
			return nil, e
		}
	} else {
		current = num(head, "version") == num(m, "charter_version")
	}
	auth := "awaiting-member-confirmation"
	switch {
	case !valid || m["state"] == "active" && !decisionValid:
		auth = "permission-unavailable"
	case num(m, "expires_at") <= s.now():
		auth = "expired"
	case !current:
		auth = "charter-reconfirmation-required"
	case m["state"] == "active":
		auth = "active"
	}
	actions := []any{}
	if a.SubjectID == m["subject_id"] {
		if m["state"] == "invited" {
			if auth == "awaiting-member-confirmation" {
				actions = append(actions, "accept")
			}
			actions = append(actions, "decline")
		} else if m["state"] == "active" {
			actions = append(actions, "exit")
		}
	} else if a.SubjectID == head["owner_id"] && has([]any{"invited", "active"}, m["state"]) {
		actions = append(actions, "remove")
	}
	out["authorization"] = auth
	out["availableActions"] = actions
	return out, nil
}
func (s *Service) Members(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("hubMembershipQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		h, e := s.head(ctx, tx, txt(in, "hubId"), false)
		if e != nil {
			return nil, e
		}
		limit := num(in, "limit")
		rows, e := query(ctx, tx, "SELECT id FROM hub_memberships_v2 WHERE hub_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3=$4 OR subject_id=$3) ORDER BY id LIMIT $5", h["id"], in["after"], a.SubjectID, h["owner_id"], limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for i, row := range rows {
			if int64(i) >= limit {
				break
			}
			v, e := s.membership(ctx, tx, a, h, txt(row, "id"))
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
		scope := "own-memberships"
		if a.SubjectID == h["owner_id"] {
			scope = "operator-memberships"
		}
		return Object{"items": items, "nextCursor": cursor(rows, limit), "scope": scope}, nil
	})
}
func (s *Service) RequireMemberWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id, scope string) (Object, error) {
	h, _, e := s.current(ctx, tx, &a, id)
	if e != nil {
		return nil, e
	}
	if a.SubjectID == h["owner_id"] {
		return Object{"head": h, "role": "operator"}, nil
	}
	m, e := one(ctx, tx, "SELECT id FROM hub_memberships_v2 WHERE hub_id=$1 AND subject_id=$2 AND state='active'", id, a.SubjectID)
	if e != nil {
		return nil, e
	}
	if m == nil {
		return nil, fault.New("hub_scope_unavailable", 403)
	}
	v, e := s.membership(ctx, tx, a, h, txt(m, "id"))
	if e != nil {
		return nil, e
	}
	if v["authorization"] != "active" || !has(arr(v["scopes"]), scope) {
		return nil, fault.New("hub_scope_unavailable", 403)
	}
	return Object{"head": h, "membership": v}, nil
}
