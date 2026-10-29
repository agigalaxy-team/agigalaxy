package community

import (
	"encoding/hex"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

func strict(o Object, allowed ...string) bool {
	set := map[string]bool{}
	for _, k := range allowed {
		set[k] = true
	}
	for k := range o {
		if !set[k] {
			return false
		}
	}
	return true
}
func integer(v any, min, max int64) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	i, e := n.Int64()
	return e == nil && i >= min && i <= max
}
func text(v any, max int) bool {
	s, ok := v.(string)
	return ok && strings.TrimSpace(s) != "" && utf8.ValidString(s) && utf8.RuneCountInString(s) <= max
}

// encoding/json replaces lone UTF-16 surrogates. The original forum text
// contract rejects them, so inspect text's encoded units before decoding loses
// that distinction. Escaped backslashes are skipped as literal characters.
func validTextBytes(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		v, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if e != nil {
			return false
		}
		i += 4
		if v >= 0xdc00 && v <= 0xdfff {
			return false
		}
		if v >= 0xd800 && v <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			next, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if e != nil || next < 0xdc00 || next > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
func topic(v string, unclassified bool) bool {
	return v == "technology" || v == "arts" || v == "learning" || v == "life" || v == "galaxy" || unclassified && v == "unclassified"
}
func legacyAudience() Object {
	return Object{"read": Object{"kind": "everyone"}, "participate": Object{"kind": "everyone"}}
}
func validRule(r Object) bool {
	switch str(r, "kind") {
	case "everyone", "accounts":
		return strict(r, "kind")
	case "selected-accounts":
		a, ok := r["accountIds"].([]any)
		if !ok || len(a) < 1 || len(a) > 64 || !strict(r, "kind", "accountIds") {
			return false
		}
		seen := map[string]bool{}
		for _, v := range a {
			s, ok := v.(string)
			if !ok || !validID(s) || seen[s] {
				return false
			}
			seen[s] = true
		}
		return true
	case "honor":
		return strict(r, "kind", "ruleId", "ruleVersion") && regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,79}$`).MatchString(str(r, "ruleId")) && regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){0,2}$`).MatchString(str(r, "ruleVersion"))
	case "external-credential":
		return strict(r, "kind", "issuerId", "conditionId") && regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$`).MatchString(str(r, "issuerId")) && regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$`).MatchString(str(r, "conditionId"))
	}
	return false
}
func validAudience(a Object) bool {
	return a != nil && strict(a, "read", "participate") && validRule(obj(a, "read")) && validRule(obj(a, "participate"))
}
func (s *Service) parse(kind string, raw string) (Object, error) {
	if len(raw) > int(num(s.policy(), "maxPayloadBytes")) {
		return nil, fail("forum_payload_too_large", 413)
	}
	var p Object
	var original map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &original) != nil {
		return nil, fail("invalid_forum_payload", 400)
	}
	for _, key := range []string{"title", "body"} {
		if v, ok := original[key]; ok && !validTextBytes(v) {
			return nil, fail("invalid_forum_payload", 400)
		}
	}
	if protocol.Decode([]byte(raw), &p) != nil || p == nil || !integer(p["schemaVersion"], 1, 1) || !validID(str(p, "operationId")) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["accountId"]; ok && (!validID(asString(v))) {
		return nil, fail("invalid_forum_payload", 400)
	}
	base := []string{"schemaVersion", "operationId", "accountId"}
	switch kind {
	case "create-post", "publish-version":
		base = append(base, "postId", "versionId", "expectedHeadVersion", "title", "body", "links", "attachments", "publishedUntil", "topic", "sectionId", "audience")
		min := int64(1)
		max := int64(9007199254740991)
		if kind == "create-post" {
			min = 0
			max = 0
		}
		if !validID(str(p, "postId")) || !validID(str(p, "versionId")) || !integer(p["expectedHeadVersion"], min, max) || !text(p["title"], 160) || !text(p["body"], 8000) {
			return nil, fail("invalid_forum_payload", 400)
		}
		links, ok := p["links"].([]any)
		if !ok || len(links) > 8 {
			return nil, fail("invalid_forum_payload", 400)
		}
		for _, v := range links {
			u, e := url.Parse(asString(v))
			if e != nil || u.Hostname() == "" || u.User != nil || u.Scheme != "http" && u.Scheme != "https" || utf8.RuneCountInString(asString(v)) > 2048 {
				return nil, fail("invalid_forum_payload", 400)
			}
		}
		if v, ok := p["topic"]; ok && !topic(asString(v), false) {
			return nil, fail("invalid_forum_payload", 400)
		}
		if v, ok := p["sectionId"]; ok && v != nil && !validID(asString(v)) {
			return nil, fail("invalid_forum_payload", 400)
		}
	case "create-reply":
		base = append(base, "replyId", "postId", "postVersionId", "expectedRevision", "body", "attachments", "publishedUntil", "replyTo", "audience")
		if !validID(str(p, "replyId")) || !validID(str(p, "postId")) || !validID(str(p, "postVersionId")) || !integer(p["expectedRevision"], 0, 0) || !text(p["body"], 2000) {
			return nil, fail("invalid_forum_payload", 400)
		}
		v, ok := p["replyTo"]
		if !ok {
			return nil, fail("invalid_forum_payload", 400)
		}
		if v != nil {
			r := obj(p, "replyTo")
			if r == nil || !strict(r, "replyId", "contentRevision") || !validID(str(r, "replyId")) || !integer(r["contentRevision"], 1, 1) {
				return nil, fail("invalid_forum_payload", 400)
			}
		}
	case "withdraw-post", "withdraw-version":
		base = append(base, "postId", "expectedHeadVersion")
		if kind == "withdraw-version" {
			base = append(base, "versionId")
			if !validID(str(p, "versionId")) {
				return nil, fail("invalid_forum_payload", 400)
			}
		}
		if !validID(str(p, "postId")) || !integer(p["expectedHeadVersion"], 1, 9007199254740991) {
			return nil, fail("invalid_forum_payload", 400)
		}
	case "withdraw-reply":
		base = append(base, "replyId", "expectedRevision")
		if !validID(str(p, "replyId")) || !integer(p["expectedRevision"], 1, 1) {
			return nil, fail("invalid_forum_payload", 400)
		}
	default:
		return nil, fail("invalid_forum_action", 400)
	}
	if !strict(p, base...) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if strings.HasPrefix(kind, "withdraw-") {
		return p, nil
	}
	if !integer(p["publishedUntil"], 1, 9007199254740991) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["audience"]; ok && (v == nil || !validAudience(obj(p, "audience"))) {
		return nil, fail("invalid_forum_payload", 400)
	}
	if v, ok := p["attachments"]; ok {
		a, ok := v.([]any)
		if !ok || len(a) > 4 {
			return nil, fail("invalid_forum_payload", 400)
		}
		seen := map[string]bool{}
		for _, item := range a {
			ref, ok := item.(map[string]any)
			if !ok || !strict(ref, "id", "sha256") || !validID(str(ref, "id")) || seen[str(ref, "id")] || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(str(ref, "sha256")) {
				return nil, fail("invalid_forum_payload", 400)
			}
			seen[str(ref, "id")] = true
		}
	}
	bmax := "maxBodyCodePoints"
	if kind == "create-reply" {
		bmax = "maxReplyCodePoints"
	}
	if utf8.RuneCountInString(str(p, "title")) > int(num(s.policy(), "maxTitleCodePoints")) || utf8.RuneCountInString(str(p, "body")) > int(num(s.policy(), bmax)) {
		return nil, fail("forum_content_limit", 413)
	}
	if links, ok := p["links"].([]any); ok {
		if len(links) > int(num(s.policy(), "maxLinks")) {
			return nil, fail("forum_content_limit", 413)
		}
		for _, v := range links {
			if utf8.RuneCountInString(asString(v)) > int(num(s.policy(), "maxLinkCodePoints")) {
				return nil, fail("forum_content_limit", 413)
			}
		}
	}
	return p, nil
}
func deriveID(kind, operation, account string, p Object, omit ...string) string {
	payload := clone(p)
	for _, k := range omit {
		delete(payload, k)
	}
	value := Object{"protocol": "galaxy-community-forum-locator", "version": 1, "kind": kind, "operationKind": operation, "payload": payload}
	if strings.HasPrefix(account, "GUID") {
		value["subjectId"] = account
	} else {
		value["actor"] = Object{"kind": "account", "accountId": account}
	}
	b, _ := identity.Canonical(value)
	h := identity.Digest(b)[:32]
	x, _ := hex.DecodeString(h)
	x[6] = (x[6] & 15) | 128
	x[8] = (x[8] & 63) | 128
	return hex.EncodeToString(x[:4]) + "-" + hex.EncodeToString(x[4:6]) + "-" + hex.EncodeToString(x[6:8]) + "-" + hex.EncodeToString(x[8:10]) + "-" + hex.EncodeToString(x[10:])
}
func assertIDs(kind, account string, p Object) error {
	if kind == "create-post" && str(p, "postId") != deriveID("post", kind, account, p, "postId", "versionId") {
		return fail("forum_locator_mismatch", 409)
	}
	if (kind == "create-post" || kind == "publish-version") && str(p, "versionId") != deriveID("post-version", kind, account, p, "versionId") {
		return fail("forum_locator_mismatch", 409)
	}
	if kind == "create-reply" && str(p, "replyId") != deriveID("reply", kind, account, p, "replyId") {
		return fail("forum_locator_mismatch", 409)
	}
	return nil
}

// BindCreatePostIDs prepares the deterministic locators for a new account post.
// The submitted payload still passes the ordinary validation and authorization.
func BindCreatePostIDs(account string, p Object) {
	p["postId"] = deriveID("post", "create-post", account, p, "postId", "versionId")
	p["versionId"] = deriveID("post-version", "create-post", account, p, "versionId")
}

// BindForumIDs derives the stable locators for a new, already-formed forum
// operation. Ordinary request validation and authorization still run on write.
func BindForumIDs(kind, actor string, p Object) bool {
	switch kind {
	case "create-post":
		BindCreatePostIDs(actor, p)
	case "publish-version":
		p["versionId"] = deriveID("post-version", kind, actor, p, "versionId")
	case "create-reply":
		p["replyId"] = deriveID("reply", kind, actor, p, "replyId")
	case "create-report":
		p["reportId"] = deriveID("report", kind, actor, p, "reportId")
	case "create-section":
		p["sectionId"] = deriveID("section", kind, actor, p, "sectionId")
	case "supplement", "withdraw-report", "appeal", "resolve":
		p["governanceEventId"] = deriveID("governance-event", kind, actor, p, "governanceEventId")
	default:
		return false
	}
	return true
}
