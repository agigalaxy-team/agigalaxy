package operationscommunity

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
)

func (s *Service) reportWithin(ctx context.Context, tx pgx.Tx, id string, lock bool) (Object, error) {
	if !validID(id) {
		return nil, invalid()
	}
	clause := " FOR SHARE"
	if lock {
		clause = " FOR UPDATE"
	}
	r, e := one(ctx, tx, "SELECT to_jsonb(r) FROM forum_reports_v1 r WHERE id=$1"+clause, id)
	if e == nil && r == nil {
		e = fail("not_found", 404)
	}
	return r, e
}
func (s *Service) independent(ctx context.Context, tx pgx.Tx, r Object, a Actor) (bool, error) {
	parties := []string{}
	for _, k := range []string{"reporter_id", "target_author_id"} {
		if v := str(r, k); v != "" && !has(parties, v) {
			parties = append(parties, v)
		}
	}
	if e := accountlinks.LockMappingsWithin(ctx, tx, s.Endpoint, parties, false); e != nil {
		return false, e
	}
	if s.domain().IsDuty(a) || s.domain().IsExecution(a) {
		e := s.domain().Principal(ctx, tx, a)
		return e == nil, e
	}
	if s.ReadPrincipalWithin == nil || s.Links == nil {
		return false, fail("operations_authorization_unavailable", 503)
	}
	p, e := s.ReadPrincipalWithin(ctx, tx, a)
	if e != nil {
		return false, e
	}
	accounts := []string{}
	for _, k := range []string{"reporter_account_id", "target_author_account_id"} {
		if v := str(r, k); v != "" {
			accounts = append(accounts, v)
		}
	}
	conflict, e := s.Links.OpsPartyConflictWithin(ctx, tx, p["issuer"], p["externalSubject"], parties, accounts)
	return !conflict, e
}
func (s *Service) reportView(ctx context.Context, tx pgx.Tx, r Object, a Actor, detail bool) (Object, error) {
	independent, e := s.independent(ctx, tx, r, a)
	if e != nil {
		return nil, e
	}
	expired := r["audit_until"] != nil && seconds(r["audit_until"]) <= s.now()
	source, e := s.Forum.OperationsSourceWithin(ctx, tx, obj(r, "target"))
	if e != nil {
		return nil, e
	}
	can := permitted(a, "cases.resolve") && independent && !expired && has([]string{"pending", "appealed"}, str(r, "state")) && num(r, "version") < num(s.policy(), "maxReportEvents")+2*num(s.policy(), "maxAppeals")+2
	accounts, e := rows(ctx, tx, "SELECT jsonb_build_object('id',a.id,'uid',a.uid,'display_name',p.display_name) FROM community_accounts a JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled WHERE a.endpoint=$1 AND a.id=ANY($2::uuid[])", s.Endpoint, []any{r["reporter_account_id"], r["target_author_account_id"]})
	if e != nil {
		return nil, e
	}
	label := func(id any) any {
		for _, v := range accounts {
			if v["id"] == id {
				return Object{"accountId": v["id"], "uid": v["uid"], "displayName": v["display_name"]}
			}
		}
		return nil
	}
	active := r["restriction_event_id"] != nil && r["restriction_until"] != nil && seconds(r["restriction_until"]) > s.now()
	expires := s.now() + 30
	if str(source, "availability") == "available" && num(source, "publishedUntil") < expires {
		expires = num(source, "publishedUntil")
	}
	base := Object{"id": r["id"], "target": r["target"], "version": r["version"], "state": r["state"], "reporterAccountId": r["reporter_account_id"], "reporterId": r["reporter_id"], "targetAuthorAccountId": r["target_author_account_id"], "targetAuthorId": r["target_author_id"], "operationsDisclosed": r["operations_disclosed"], "title": obj(source, "content")["title"], "reporter": label(r["reporter_account_id"]), "targetAuthor": label(r["target_author_account_id"]), "createdAt": iso(r["created_at"]), "closedAt": iso(r["closed_at"]), "restrictedUntil": iso(r["restriction_until"]), "canModerate": can, "maxHideSeconds": s.policy()["maxGovernanceHideSeconds"], "knownPartyConflict": !independent, "checkedAt": s.now(), "readExpiresAt": expires, "currentEffect": Object{"active": active, "until": iso(r["restriction_until"]), "restrictionEventId": r["restriction_event_id"], "scope": "this-case-only", "canKeep": can, "canRelease": can && active, "canHide": can && str(source, "availability") == "available"}}
	if !detail {
		return base, nil
	}
	events := []Object{}
	if independent && !expired && yes(r, "operations_disclosed") {
		originals, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM forum_governance_events_v1 e WHERE report_id=$1 AND actor_kind='official-account' ORDER BY version", r["id"])
		if e != nil {
			return nil, e
		}
		for _, event := range originals {
			ok, e := s.Forum.OperationsNarrativeWithin(ctx, tx, event)
			if e != nil {
				return nil, e
			}
			if !ok {
				continue
			}
			var p Object
			if e = protocol.Decode([]byte(str(event, "payload_text")), &p); e != nil {
				return nil, e
			}
			summary := p["summary"]
			if summary == nil {
				summary = p["reason"]
			}
			events = append(events, Object{"id": event["id"], "version": event["version"], "kind": event["kind"], "actorKind": "official-account", "accountId": event["account_id"], "summary": summary, "createdAt": iso(event["created_at"])})
		}
	}
	decisions, decisionRows := []Object{}, []Object{}
	if independent && !expired {
		decisions, e = rows(ctx, tx, "SELECT to_jsonb(e) FROM forum_operations_events_v1 e WHERE report_id=$1 AND retained_until>$2 ORDER BY version", r["id"], stamp(s.now()))
		if e != nil {
			return nil, e
		}
		decisionRows, e = rows(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT id,version,'identity'::text AS actor_kind,subject_id AS actor_id,resolution,effect_until,NULL::text AS restriction_action,created_at FROM forum_governance_events_v1 WHERE report_id=$1 AND kind='resolve' UNION ALL SELECT id,version,actor_kind,operator_id AS actor_id,resolution,effect_until,restriction_action,created_at FROM forum_operations_events_v1 WHERE report_id=$1 AND retained_until>$2 ORDER BY version)v`, r["id"], stamp(s.now()))
		if e != nil {
			return nil, e
		}
	}
	ids := []string{}
	for _, v := range decisions {
		ids = append(ids, str(v, "operator_id"))
	}
	for _, v := range decisionRows {
		if str(v, "actor_kind") == "business-operator" {
			ids = append(ids, str(v, "actor_id"))
		}
	}
	names, e := s.domain().NamesWithin(ctx, tx, ids)
	if e != nil {
		return nil, e
	}
	for _, v := range decisions {
		events = append(events, Object{"id": v["id"], "version": v["version"], "kind": "resolve", "actorKind": v["actor_kind"], "operatorId": v["operator_id"], "operatorDisplayName": names[str(v, "operator_id")], "resolution": v["resolution"], "summary": v["summary"], "restrictionAction": v["restriction_action"], "effectUntil": iso(v["effect_until"]), "createdAt": iso(v["created_at"])})
	}
	decisionView := func(v Object) any {
		if v == nil {
			return nil
		}
		var name any
		if str(v, "actor_kind") == "business-operator" {
			name = names[str(v, "actor_id")]
		}
		return Object{"id": v["id"], "version": v["version"], "actorKind": v["actor_kind"], "actorId": v["actor_id"], "operatorDisplayName": name, "resolution": v["resolution"], "restrictionAction": v["restriction_action"], "effectUntil": iso(v["effect_until"]), "createdAt": iso(v["created_at"])}
	}
	var initial, current Object
	for _, v := range decisionRows {
		if initial == nil {
			initial = v
		}
		if v["id"] == r["decision_event_id"] {
			current = v
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return num(events[i], "version") < num(events[j], "version") })
	base["source"], base["events"], base["initialDecision"], base["currentDecision"] = source, events, decisionView(initial), decisionView(current)
	base["resultDelivery"] = delivery()
	base["legacyPrivateNarrativeGranted"], base["originalAudienceChanged"] = false, false
	return base, nil
}
func delivery() Object {
	return Object{"channel": "original-case-read", "state": "readable", "notification": "not-connected"}
}
func (s *Service) Reports(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parsePage(input, "reports")
	if e != nil {
		return nil, e
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-reports-query", q, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM forum_reports_v1 r WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR state=$2) ORDER BY id LIMIT $3", q["after"], q["state"], num(q, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []Object{}
		var next any
		expires := s.now() + 30
		for i, x := range r {
			if int64(i) == num(q, "limit") {
				next = r[i-1]["id"]
				break
			}
			v, e := s.reportView(ctx, tx, x, a, false)
			if e != nil {
				return nil, e
			}
			if num(v, "readExpiresAt") < expires {
				expires = num(v, "readExpiresAt")
			}
			items = append(items, v)
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now(), "readExpiresAt": expires}, nil
	})
}
func (s *Service) Report(ctx context.Context, a Actor, id string) (Object, error) {
	if e := s.ready(); e != nil {
		return nil, e
	}
	return s.domain().Run(ctx, a, "community-report-read", Object{"id": id}, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.reportWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		return s.reportView(ctx, tx, r, a, true)
	})
}
func (s *Service) Resolve(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	x, e := parseWrite(input, "resolve")
	if e != nil || !validID(id) {
		return nil, invalid()
	}
	if e = s.ready(); e != nil {
		return nil, e
	}
	selection := copyObject(x)
	delete(selection, "summary")
	selection["id"], selection["summaryDigest"] = id, digest(str(x, "summary"))
	return s.domain().Command(ctx, a, "community-report-resolve", selection, func(tx pgx.Tx, a Actor) (Object, error) {
		r, e := s.reportWithin(ctx, tx, id, true)
		if e != nil {
			return nil, e
		}
		v, e := s.reportView(ctx, tx, r, a, true)
		if e != nil {
			return nil, e
		}
		if num(r, "version") != num(x, "expectedVersion") {
			return nil, fail("forum_report_version_conflict", 409)
		}
		if !yes(v, "canModerate") {
			return nil, fail("forum_independent_handler_required", 403)
		}
		var exists bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM forum_governance_events_v1 WHERE id=$1 OR operation_id=$1)", x["operationId"]).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fail("business_admin_operation_conflict", 409)
		}
		if _, ok := x["hideUntil"]; ok {
			until := num(x, "hideUntil")
			if str(x, "resolution") != "accepted" || until <= s.now() || until > s.now()+num(s.policy(), "maxGovernanceHideSeconds") || str(obj(v, "source"), "availability") != "available" || until > num(obj(v, "source"), "publishedUntil") {
				return nil, fail("forum_hide_expiry", 409)
			}
		}
		action := str(x, "restrictionAction")
		if action == "" {
			action = "keep"
			if x["hideUntil"] != nil {
				action = "hide"
			}
		}
		if action == "release" && !yes(obj(v, "currentEffect"), "canRelease") {
			return nil, fail("forum_case_restriction_unavailable", 409)
		}
		var until any
		if r["restriction_until"] != nil {
			until = stamp(seconds(r["restriction_until"]))
		}
		event := r["restriction_event_id"]
		if action == "hide" {
			until = stamp(num(x, "hideUntil"))
			event = x["operationId"]
		} else if action == "release" {
			until, event = nil, nil
		}
		version := num(r, "version") + 1
		at, retained := stamp(s.now()), stamp(s.now()+num(s.policy(), "auditDays")*86400)
		_, e = tx.Exec(ctx, `INSERT INTO forum_operations_events_v1(id,report_id,operator_id,http_request_id,version,resolution,summary,effect_until,created_at,retained_until,restriction_action,actor_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, x["operationId"], id, a.ID, a.RequestID, version, x["resolution"], x["summary"], until, at, retained, action, actorKind(s, a))
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "UPDATE forum_reports_v1 SET version=$2,state='resolved',decision_event_id=$3,restriction_event_id=$4,restriction_until=$5,closed_at=$6,audit_until=$7 WHERE id=$1", id, version, x["operationId"], event, until, at, retained)
		return Object{"reportId": id, "version": version, "state": "resolved", "resolution": x["resolution"], "restrictionAction": action, "restrictionEventId": event, "effectUntil": iso(until), "actorKind": actorKind(s, a), "operatorId": a.ID, "resultDelivery": delivery()}, e
	})
}
