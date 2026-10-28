package identitygroups

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) proposal(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, op Object) (Object, error) {
	if op == nil || op["subject_id"] != a.SubjectID && !has(arr(op["required_ids"]), a.SubjectID) {
		return nil, fault.New("identity_group_unavailable", 404)
	}
	status, e := s.state(ctx, tx, op, &a)
	if e != nil {
		return nil, e
	}
	actions := []any{}
	control, e := s.optionalControl(ctx, tx, &a)
	if e != nil {
		return nil, e
	}
	if status["state"] == "pending" && txt(op, "payload_text") != "" && control != nil && has(arr(op["required_ids"]), a.SubjectID) {
		var own Object
		for _, raw := range arr(status["approvals"]) {
			if obj(raw)["subjectId"] == a.SubjectID {
				own = obj(raw)
				break
			}
		}
		approved := own["decision"] == "approve" && own["keyId"] == control.KeyID && num(own, "epoch") == control.Epoch && num(own, "expiresAt") > s.now()
		pending, e := s.deletionPending(ctx, tx, []string{a.SubjectID})
		if e != nil {
			return nil, e
		}
		if !approved && !pending {
			actions = append(actions, "approve")
		}
		actions = append(actions, "decline")
		if op["subject_id"] == a.SubjectID {
			actions = append(actions, "cancel")
		}
	}
	var text any
	if txt(op, "payload_text") != "" {
		text = op["payload_text"]
	}
	sources := []any{}
	p := payload(op)
	if p != nil && p["kind"] != "revoke" {
		sources, e = s.sources(ctx, tx, &a, arr(p["sourceRefs"]))
		if e != nil {
			return nil, e
		}
	}
	status["payloadJson"] = text
	status["proposerId"] = op["subject_id"]
	status["kind"] = op["kind"]
	status["sources"] = sources
	status["availableActions"] = actions
	status["originalIdsPreserved"] = true
	status["capabilityMerged"] = false
	return status, nil
}
func validID(id string) bool {
	in, _ := protocol.Encode(Object{"operationId": id, "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
	_, e := parse("identityGroupReceiptSchema", in)
	return e == nil
}
func (s *Service) Proposal(ctx context.Context, a deviceauth.Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, fault.New("invalid_identity_group", 400)
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		op, e := one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		return s.proposal(ctx, tx, a, op)
	})
}

type manifest struct {
	op, p                                  Object
	active, own, pending, erased, complete bool
}

func (s *Service) manifest(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, g Object) (*manifest, error) {
	op, e := one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1", g["current_operation_id"])
	if e != nil {
		return nil, e
	}
	if txt(op, "payload_text") == "" {
		return nil, nil
	}
	p := payload(op)
	if p["kind"] == "revoke" {
		previous, e := one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1", p["previousOperationId"])
		if e != nil {
			return nil, e
		}
		if txt(previous, "payload_text") == "" {
			return nil, nil
		}
		p = payload(previous)
	}
	own := a != nil && has(arr(p["memberIds"]), a.SubjectID)
	allowed := own || p["visibility"] == "Public" || a != nil && has(arr(p["viewers"]), a.SubjectID)
	if !allowed {
		return nil, fault.New("identity_group_unavailable", 404)
	}
	ids := []string{}
	for _, id := range arr(p["memberIds"]) {
		ids = append(ids, id.(string))
	}
	pending, e := s.deletionPending(ctx, tx, ids)
	if e != nil {
		return nil, e
	}
	erased := g["source_erased_at"] != nil
	operationID := op["id"]
	if op["kind"] == "revoke" {
		operationID = payload(op)["previousOperationId"]
	}
	rows, e := query(ctx, tx, "SELECT DISTINCT subject_id FROM identity_group_approvals_v2 WHERE operation_id=$1 AND decision='approve'", operationID)
	if e != nil {
		return nil, e
	}
	approved := []any{}
	for _, row := range rows {
		approved = append(approved, row["subject_id"])
	}
	complete := true
	for _, id := range arr(p["memberIds"]) {
		complete = complete && has(approved, id)
	}
	return &manifest{op, p, g["state"] == "active" && !pending && !erased && complete, own, pending, erased, complete}, nil
}
func (s *Service) view(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, g Object) (Object, error) {
	m, e := s.manifest(ctx, tx, a, g)
	if e != nil {
		return nil, e
	}
	if m == nil || ((m.pending || m.erased) && !m.own) {
		return nil, fault.New("identity_group_unavailable", 404)
	}
	p := m.p
	sources := []any{}
	if m.active {
		for _, raw := range arr(p["sourceRefs"]) {
			ref := obj(raw)
			source, e := s.SourceWithin(ctx, tx, a, ref, false)
			if e != nil {
				if !unavailable(e) {
					return nil, e
				}
				sources = append(sources, Object{"ref": ref, "state": "unavailable", "record": nil})
				continue
			}
			var correction Object
			for _, raw := range arr(p["attributionCorrections"]) {
				if factsKey(obj(obj(raw)["source"])) == factsKey(ref) {
					correction = obj(raw)
					break
				}
			}
			display := ref["originalSubjectId"]
			if correction != nil {
				display = correction["displaySubjectId"]
			}
			source["displaySubjectId"] = display
			source["attributionCorrection"] = correction
			source["originalActorUnchanged"] = true
			sources = append(sources, source)
		}
	}
	var control *deviceauth.ControlAuthorization
	if m.own {
		control, e = s.optionalControl(ctx, tx, a)
		if e != nil {
			return nil, e
		}
	}
	actions := []any{}
	if g["state"] == "active" && m.own && control != nil {
		if !m.erased && !m.pending {
			actions = append(actions, "revise")
		}
		actions = append(actions, "revoke")
	}
	state := g["state"]
	switch {
	case m.erased:
		state = "source-deleted"
	case m.pending:
		state = "source-deletion-pending"
	case g["state"] == "active" && !m.complete:
		state = "control-evidence-unavailable"
	}
	members := []any{}
	var canonical any
	if m.active || m.own {
		members = arr(p["memberIds"])
	}
	if m.active {
		canonical = p["canonicalDisplayId"]
	}
	history := []any{}
	caseIDs := []string{}
	caseGroups := []any{}
	if m.active {
		positions := map[string]int{}
		for _, raw := range sources {
			source := obj(raw)
			if source["record"] == nil {
				continue
			}
			ref := obj(source["ref"])
			key := factsKey(ref)
			if i, ok := positions[key]; ok {
				history[i] = source
			} else {
				positions[key] = len(history)
				history = append(history, source)
			}
			if id := txt(ref, "caseId"); id != "" && !hasStrings(caseIDs, id) {
				caseIDs = append(caseIDs, id)
			}
		}
		for _, id := range caseIDs {
			events := []any{}
			for _, raw := range sources {
				source := obj(raw)
				if source["record"] != nil && obj(source["ref"])["caseId"] == id {
					events = append(events, source)
				}
			}
			caseGroups = append(caseGroups, Object{"caseId": id, "events": events, "capabilityMerged": false})
		}
	}
	return Object{"groupId": g["id"], "version": g["version"], "operationId": g["current_operation_id"], "state": state, "memberIds": members, "canonicalDisplayId": canonical, "visibility": p["visibility"], "viewers": p["viewers"], "sources": sources, "sourceCount": len(arr(p["sourceRefs"])), "originalIdsPreserved": true, "capabilityMerged": false, "accessGranted": false, "permissionMeaning": "each-original-source-is-read-as-current-viewer; group-is-display-only", "canRevoke": has(actions, "revoke"), "availableActions": actions, "history": history, "caseGroups": caseGroups, "historyDedup": "original-event-or-configuration-id-and-version; no-capability-statistics", "checkedAt": s.now()}, nil
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	g, e := one(ctx, tx, "SELECT * FROM identity_groups_v2 WHERE id=$1", id)
	if e != nil {
		return nil, e
	}
	if g == nil {
		return nil, fault.New("identity_group_unavailable", 404)
	}
	return s.view(ctx, tx, a, g)
}
func (s *Service) Read(ctx context.Context, a *deviceauth.Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, fault.New("invalid_identity_group", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, a, id)
	})
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("identityGroupQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var subject any = in["subjectId"]
		if subject == nil && a != nil {
			subject = a.SubjectID
		}
		rows, e := query(ctx, tx, "SELECT * FROM identity_groups_v2 WHERE ($1::text IS NULL OR member_ids ? $1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 200", subject, in["after"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		var last any
		for _, g := range rows {
			last = g["id"]
			v, e := s.view(ctx, tx, a, g)
			if e != nil {
				if !unavailable(e) {
					return nil, e
				}
			} else {
				items = append(items, v)
			}
			if int64(len(items)) == num(in, "limit") {
				break
			}
		}
		var next any
		if len(rows) > 0 && (last != rows[len(rows)-1]["id"] || len(rows) == 200) {
			next = last
		}
		proposals := []any{}
		var proposalNext any
		if in["includeProposals"] == true && a != nil {
			limit := num(in, "proposalLimit")
			operations, e := query(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE required_ids ? $1 AND state='pending' AND expires_at>$2 AND ($3::uuid IS NULL OR id>$3) AND ($4='all' OR ($4='incoming' AND subject_id<>$1) OR ($4='outgoing' AND subject_id=$1)) ORDER BY id LIMIT $5", a.SubjectID, time.Unix(s.now(), 0), in["proposalAfter"], in["proposalDirection"], limit+1)
			if e != nil {
				return nil, e
			}
			for i, op := range operations {
				if int64(i) >= limit {
					break
				}
				v, e := s.proposal(ctx, tx, *a, op)
				if e != nil {
					return nil, e
				}
				proposals = append(proposals, v)
			}
			if int64(len(operations)) > limit {
				proposalNext = operations[limit-1]["id"]
			}
		}
		return Object{"items": items, "next": next, "proposals": proposals, "proposalNext": proposalNext, "coverage": "authorized-canonical-display-groups", "capabilityMerged": false}, nil
	})
}
func (s *Service) Resolve(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	var in Object
	if protocol.Decode(raw, &in) != nil || len(in) != 1 {
		return nil, fault.New("invalid_identity_group", 400)
	}
	if _, e := parse("identityGroupQuerySchema", raw); e != nil {
		return nil, e
	}
	if in["subjectId"] == nil {
		return nil, fault.New("invalid_identity_group", 400)
	}
	result, e := s.Query(ctx, a, raw)
	if e != nil {
		return nil, e
	}
	ids := []any{}
	for _, raw := range arr(result["items"]) {
		g := obj(raw)
		if g["state"] == "active" && !has(ids, g["canonicalDisplayId"]) {
			ids = append(ids, g["canonicalDisplayId"])
		}
	}
	result["canonicalDisplayIds"] = ids
	result["ambiguous"] = len(ids) > 1
	result["automaticIdentitySelection"] = false
	return result, nil
}
