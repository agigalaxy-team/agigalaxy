package community

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"regexp"
)

func validTarget(t Object) bool {
	switch str(t, "kind") {
	case "post-version":
		return strict(t, "kind", "postId", "versionId") && validID(str(t, "postId")) && validID(str(t, "versionId"))
	case "reply":
		return strict(t, "kind", "replyId", "contentRevision") && validID(str(t, "replyId")) && integer(t["contentRevision"], 1, 1)
	}
	return false
}
func stringsArray(v any, max int, valid func(string) bool) ([]string, bool) {
	a, ok := v.([]any)
	if !ok || len(a) > max {
		return nil, false
	}
	out := []string{}
	for _, x := range a {
		s, ok := x.(string)
		if !ok || !valid(s) {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}
func (s *Service) parseReport(raw string, event bool) (Object, error) {
	if len(raw) > int(num(s.policy(), "maxPayloadBytes")) {
		return nil, fail("forum_payload_too_large", 413)
	}
	var p Object
	if protocol.Decode([]byte(raw), &p) != nil || p == nil || !integer(p["schemaVersion"], 1, 1) || !validID(str(p, "operationId")) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["accountId"]; ok && !validID(asString(v)) {
		return nil, fail("invalid_forum_payload", 400)
	}
	allowed := []string{"schemaVersion", "operationId", "accountId", "reportId", "handlerIds"}
	if !validID(str(p, "reportId")) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["handlerIds"]; ok {
		if _, ok := stringsArray(v, 128, func(s string) bool {
			return regexp.MustCompile(`^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$`).MatchString(s)
		}); !ok {
			return nil, fail("invalid_forum_payload", 400)
		}
	}
	if !event {
		allowed = append(allowed, "target", "category", "summary")
		if !validTarget(obj(p, "target")) || !text(p["summary"], 1600) || !hasString([]string{"spam", "harassment", "privacy", "misleading", "other"}, str(p, "category")) {
			return nil, fail("invalid_forum_payload", 400)
		}
	} else {
		allowed = append(allowed, "governanceEventId", "expectedReportVersion", "kind")
		if !validID(str(p, "governanceEventId")) || !integer(p["expectedReportVersion"], 1, 9007199254740991) {
			return nil, fail("invalid_forum_payload", 400)
		}
		switch str(p, "kind") {
		case "supplement", "appeal":
			allowed = append(allowed, "summary")
			if !text(p["summary"], 1600) {
				return nil, fail("invalid_forum_payload", 400)
			}
		case "withdraw":
		case "resolve":
			allowed = append(allowed, "resolution", "reason", "effect", "accountViewers")
			if !text(p["reason"], 1600) || !hasString([]string{"dismissed", "accepted", "needs-review"}, str(p, "resolution")) {
				return nil, fail("invalid_forum_payload", 400)
			}
			effect, present := p["effect"]
			if !present {
				return nil, fail("invalid_forum_payload", 400)
			}
			if effect != nil {
				e := obj(p, "effect")
				if !strict(e, "kind", "until") || str(e, "kind") != "hide-version" || !integer(e["until"], 1, 9007199254740991) {
					return nil, fail("invalid_forum_payload", 400)
				}
			}
			if v, ok := p["accountViewers"]; ok {
				if _, ok := stringsArray(v, 64, validID); !ok {
					return nil, fail("invalid_forum_payload", 400)
				}
			}
		default:
			return nil, fail("invalid_forum_payload", 400)
		}
	}
	if !strict(p, allowed...) {
		return nil, fail("invalid_forum_payload", 400)
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal([]byte(raw), &fields)
	for _, key := range []string{"summary", "reason"} {
		if v, ok := fields[key]; ok {
			if !validTextBytes(v) {
				return nil, fail("invalid_forum_payload", 400)
			}
			if len([]rune(str(p, key))) > int(num(s.policy(), "maxReportCodePoints")) {
				return nil, fail("forum_content_limit", 413)
			}
		}
	}
	return p, nil
}
func (s *Service) writeTarget(account string, p Object) (string, error) {
	target := str(p, "accountId")
	if target == "" || target == account {
		return account, nil
	}
	if s.actor == nil {
		return "", fail("official_account_changed", 409)
	}
	if account != "" {
		return "", fail("forum_account_target_mismatch", 409)
	}
	return target, nil
}
func (s *Service) reportTarget(ctx context.Context, tx pgx.Tx, target Object, account string, read bool) (Object, Object, error) {
	if str(target, "kind") == "post-version" {
		r, e := s.version(ctx, tx, str(target, "postId"), str(target, "versionId"))
		if e != nil {
			return nil, nil, e
		}
		if r == nil {
			return nil, nil, fail("not_found", 404)
		}
		if !read {
			return r, nil, nil
		}
		view, e := s.readVersion(ctx, tx, str(target, "postId"), str(target, "versionId"), account)
		return r, view, e
	}
	r, e := s.reply(ctx, tx, str(target, "replyId"))
	if e != nil {
		return nil, nil, e
	}
	if r == nil {
		return nil, nil, fail("not_found", 404)
	}
	if !read {
		return r, nil, nil
	}
	view, e := s.readReply(ctx, tx, str(target, "replyId"), account)
	return r, view, e
}
