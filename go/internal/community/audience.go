package community

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func (s *Service) rule(ctx context.Context, tx pgx.Tx, account string, r Object) (bool, error) {
	switch str(r, "kind") {
	case "source-audience":
		if account != "" && str(r, "authorAccountId") == account {
			return true, nil
		}
		return s.rule(ctx, tx, account, obj(r, "rule"))
	case "everyone":
		return true, nil
	case "accounts":
		return account != "", nil
	case "selected-accounts":
		if account == "" {
			return false, nil
		}
		a, _ := r["accountIds"].([]any)
		for _, id := range a {
			if asString(id) == account {
				return true, nil
			}
		}
	case "honor", "external-credential":
		if account != "" && s.Conditions != nil {
			return s.Conditions.Matches(ctx, tx, account, r)
		}
	}
	return false, nil
}
func (s *Service) section(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	if id == "" {
		return nil, nil
	}
	return row(ctx, tx, "SELECT to_jsonb(s) FROM forum_sections_v2 s WHERE id=$1"+s.readShare(" FOR SHARE"), id)
}
func (s *Service) operationsHidden(ctx context.Context, tx pgx.Tx, kind, id string) (bool, error) {
	if s.ignoreOperationsVisibility {
		return false, nil
	}
	var hidden bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3 AND hidden_until>$4)", s.Endpoint, kind, id, s.now()).Scan(&hidden)
	return hidden, e
}
func (s *Service) sectionAllowed(ctx context.Context, tx pgx.Tx, account string, section Object, participate bool) (bool, error) {
	if section == nil {
		return false, nil
	}
	hidden, e := s.operationsHidden(ctx, tx, "forum-section", str(section, "id"))
	if e != nil {
		return false, e
	}
	owner := account != "" && str(section, "maintainer_account_id") == account
	if hidden && (participate || !owner) {
		return false, nil
	}
	if participate && str(section, "state") != "active" {
		return false, nil
	}
	if owner {
		return true, nil
	}
	a := obj(section, "audience")
	allowed, e := s.rule(ctx, tx, account, obj(a, "read"))
	if e != nil || !allowed || !participate {
		return allowed, e
	}
	return s.rule(ctx, tx, account, obj(a, "participate"))
}
func audienceOf(r Object) Object {
	if a := obj(r, "audience"); a != nil {
		return a
	}
	return legacyAudience()
}
func (s *Service) publication(ctx context.Context, tx pgx.Tx, account string, p, previous Object) (Object, error) {
	a := obj(p, "audience")
	if a == nil {
		a = audienceOf(previous)
	}
	for _, mode := range []string{"read", "participate"} {
		rule := obj(a, mode)
		if str(rule, "kind") == "honor" || str(rule, "kind") == "external-credential" {
			if s.Conditions == nil {
				return nil, fail("forum_condition_unavailable", 409)
			}
			if e := s.Conditions.Validate(ctx, tx, rule); e != nil {
				return nil, e
			}
		}
	}
	sectionID, provided := p["sectionId"]
	if !provided && previous != nil {
		sectionID = previous["section_id"]
	}
	if sectionID != nil {
		section, e := s.section(ctx, tx, asString(sectionID))
		if e != nil {
			return nil, e
		}
		ok, e := s.sectionAllowed(ctx, tx, account, section, true)
		if e != nil {
			return nil, e
		}
		if !ok {
			return nil, fail("forum_section_participation_denied", 403)
		}
	}
	return Object{"audience": a, "sectionId": sectionID}, nil
}
func (s *Service) participation(ctx context.Context, tx pgx.Tx, account string, source Object) (bool, error) {
	if account == "" {
		return false, nil
	}
	ok, e := s.rule(ctx, tx, account, obj(audienceOf(source), "participate"))
	if e != nil || !ok {
		return ok, e
	}
	if id := str(source, "section_id"); id != "" {
		section, e := s.section(ctx, tx, id)
		if e != nil {
			return false, e
		}
		return s.sectionAllowed(ctx, tx, account, section, true)
	}
	return true, nil
}
func (s *Service) snapshot(ctx context.Context, tx pgx.Tx, r Object) ([]any, error) {
	out := []any{Object{"kind": "source-audience", "authorAccountId": r["account_id"], "rule": obj(audienceOf(r), "read")}}
	if id := str(r, "section_id"); id != "" {
		section, e := s.section(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		if section == nil {
			return nil, fail("forum_source_unavailable", 403)
		}
		out = append(out, Object{"kind": "source-audience", "authorAccountId": section["maintainer_account_id"], "rule": obj(obj(section, "audience"), "read")})
	}
	return out, nil
}
func (s *Service) audienceAllowed(ctx context.Context, tx pgx.Tx, account string, r Object) (bool, error) {
	if s.actor != nil && str(r, "subject_id") == s.actor.actor.SubjectID {
		return true, nil
	}
	if account != "" && str(r, "account_id") == account {
		return true, nil
	}
	if !truth(r, "audience_inherited") {
		ok, e := s.rule(ctx, tx, account, obj(audienceOf(r), "read"))
		if e != nil || !ok {
			return ok, e
		}
	}
	parents, _ := r["parent_audience"].([]any)
	for _, v := range parents {
		rule, _ := v.(map[string]any)
		ok, e := s.rule(ctx, tx, account, rule)
		if e != nil || !ok {
			return ok, e
		}
	}
	if id := str(r, "section_id"); id != "" {
		section, e := s.section(ctx, tx, id)
		if e != nil {
			return false, e
		}
		return s.sectionAllowed(ctx, tx, account, section, false)
	}
	return true, nil
}
func (s *Service) hidden(ctx context.Context, tx pgx.Tx, target Object) (bool, error) {
	kind, id := "forum-post", str(target, "postId")
	if str(target, "kind") == "reply" {
		kind = "forum-reply"
		id = str(target, "replyId")
	}
	hidden, e := s.operationsHidden(ctx, tx, kind, id)
	if e != nil || hidden {
		return hidden, e
	}
	if kind == "forum-reply" {
		hidden, e = s.operationsHidden(ctx, tx, "forum-post", str(target, "postId"))
		if e != nil || hidden {
			return hidden, e
		}
	}
	if s.Governance != nil {
		return s.Governance.Hidden(ctx, tx, target)
	}
	q := clone(target)
	delete(q, "postId")
	delete(q, "postVersionId")
	if kind != "forum-reply" {
		q = Object{"kind": "post-version", "postId": target["postId"], "versionId": target["versionId"]}
	}
	return s.governanceHidden(ctx, tx, q)
}
