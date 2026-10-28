package projects

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
	"unicode/utf8"
)

var directoryFields = []string{"kind", "title", "summary", "functions", "technologies", "participantKind", "sourceUrl"}

func (s *Service) cursorCipher() (cipher.AEAD, error) {
	s.cursorOnce.Do(func() { s.cursorKey = make([]byte, 32); _, s.cursorError = rand.Read(s.cursorKey) })
	if s.cursorError != nil {
		return nil, s.cursorError
	}
	block, e := aes.NewCipher(s.cursorKey)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(block)
}
func (s *Service) sealCursor(value Object) (string, error) {
	a, e := s.cursorCipher()
	if e != nil {
		return "", e
	}
	iv := make([]byte, 12)
	if _, e = rand.Read(iv); e != nil {
		return "", e
	}
	value["expiresAt"] = s.now() + 900
	sealed := a.Seal(nil, iv, encode(value), []byte("galaxy-project-directory-v2"))
	out := append(iv, sealed[len(sealed)-16:]...)
	out = append(out, sealed[:len(sealed)-16]...)
	return base64.RawURLEncoding.EncodeToString(out), nil
}
func (s *Service) openCursor(value, queryHash, viewer string) (Object, error) {
	bad := func() (Object, error) { return nil, fail("project_directory_cursor_unavailable_restart", 409) }
	raw, e := base64.RawURLEncoding.DecodeString(value)
	if e != nil || len(raw) < 29 || base64.RawURLEncoding.EncodeToString(raw) != value {
		return bad()
	}
	a, e := s.cursorCipher()
	if e != nil {
		return nil, e
	}
	sealed := append(append([]byte{}, raw[28:]...), raw[12:28]...)
	plain, e := a.Open(nil, raw[:12], sealed, []byte("galaxy-project-directory-v2"))
	if e != nil {
		return bad()
	}
	var c Object
	if protocol.Decode(plain, &c) != nil || c == nil || num(c, "v") != 2 || str(c, "queryHash") != queryHash || c["viewerId"] != nullable(viewer) || num(c, "expiresAt") <= s.now() {
		return bad()
	}
	return c, nil
}
func (s *Service) directoryItem(ctx context.Context, tx pgx.Tx, id string, q Object, portfolio bool) (Object, error) {
	view, e := s.readWithin(ctx, tx, "", id, false, false)
	if e != nil {
		return nil, e
	}
	p, e := s.project(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	latest, e := row(ctx, tx, "SELECT to_jsonb(e) FROM project_events_v2 e WHERE operation_id=$1", p["document_event_id"])
	if e != nil {
		return nil, e
	}
	grant, e := s.grant(ctx, tx, latest)
	if e != nil {
		return nil, e
	}
	document := obj(view, "document")
	if !s.canRead(grant, "") || !truth(document, "discoverable") {
		return nil, nil
	}
	public := Object{}
	for _, field := range directoryFields {
		if v, ok := document[field]; ok {
			public[field] = v
		}
	}
	sources := []Object{}
	for _, source := range obj(view, "source")["fieldSources"].([]Object) {
		if contains(directoryFields, str(source, "field")) {
			sources = append(sources, source)
		}
	}
	item := Object{"projectId": id, "ownerId": view["ownerId"], "document": public, "classification": "self-declared", "capabilityVerified": false, "legalOwnershipVerified": false, "source": Object{"kind": "project", "projectId": id, "fieldSources": sources}}
	if portfolio {
		return item, nil
	}
	wish, e := s.EffectiveWishWithin(ctx, tx, str(view, "ownerId"), id, false, nil)
	if e != nil {
		return nil, e
	}
	if !truth(wish, "enabled") || str(q, "purpose") != "" && !contains(wishStrings(wish["purposes"]), str(q, "purpose")) || str(q, "kind") != "" && q["kind"] != document["kind"] {
		return nil, nil
	}
	publicFunctions := wishTags(document["functions"])
	allowed := []string{}
	restricted := wishStrings(wish["functions"])
	for _, value := range publicFunctions {
		if len(restricted) == 0 || contains(restricted, value) {
			allowed = append(allowed, value)
		}
	}
	if len(allowed) == 0 {
		return nil, nil
	}
	text := strings.Join(append([]string{str(document, "title"), str(document, "summary")}, wishStrings(document["functions"])...), "\n")
	if str(q, "query") != "" && !strings.Contains(NormalizeFunction(text), str(q, "query")) {
		return nil, nil
	}
	item["discovery"] = Object{"purposes": wish["purposes"], "functions": allowed, "functionsRestricted": len(restricted) > 0, "temporaryUntil": wish["temporaryUntil"], "contactRequiresCurrentCheck": true}
	return item, nil
}
func (s *Service) PublicDirectory(ctx context.Context, a Actor, raw []byte) (Object, error) {
	return s.publicCollection(ctx, a, raw, false)
}
func (s *Service) PublicPortfolio(ctx context.Context, a Actor, raw []byte) (Object, error) {
	return s.publicCollection(ctx, a, raw, true)
}
func (s *Service) publicCollection(ctx context.Context, a Actor, raw []byte, portfolio bool) (Object, error) {
	bad := func() error {
		if portfolio {
			return fail("invalid_project_portfolio_query", 400)
		}
		return fail("invalid_project_directory_query", 400)
	}
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil {
		return nil, bad()
	}
	if portfolio {
		if !strict(q, "ownerId", "limit", "after") || !subjectPattern.MatchString(str(q, "ownerId")) {
			return nil, bad()
		}
	} else {
		if !strict(q, "query", "kind", "purpose", "limit", "after") {
			return nil, bad()
		}
		if _, ok := q["query"]; !ok {
			q["query"] = ""
		}
		text, ok := q["query"].(string)
		if !ok || utf8.RuneCountInString(trim(text)) > 200 {
			return nil, bad()
		}
		q["query"] = NormalizeFunction(trim(text))
		if v, ok := q["kind"]; ok && !contains([]string{"project", "module"}, func() string { s, _ := v.(string); return s }()) {
			return nil, bad()
		}
		if v, ok := q["purpose"]; ok && !contains([]string{"conversation", "reuse", "collaboration", "recruitment"}, func() string { s, _ := v.(string); return s }()) {
			return nil, bad()
		}
	}
	if _, ok := q["limit"]; !ok {
		q["limit"] = 20
	}
	if !integer(q["limit"], 1, 20) {
		return nil, bad()
	}
	if v, ok := q["after"]; ok && v != nil {
		value, ok := v.(string)
		if !ok || value == "" || utf8.RuneCountInString(value) > 2048 {
			return nil, bad()
		}
	}
	hashInput := Object{"query": str(q, "query"), "kind": q["kind"], "purpose": q["purpose"], "limit": q["limit"]}
	if portfolio {
		hashInput["collection"] = "portfolio"
		hashInput["ownerId"] = q["ownerId"]
	}
	b, e := identity.Canonical(hashInput)
	if e != nil {
		return nil, e
	}
	queryHash := identity.Digest(b)
	viewer := ""
	if a.Device != nil {
		viewer = a.Device.SubjectID
	}
	var cursor Object
	if str(q, "after") != "" {
		cursor, e = s.openCursor(str(q, "after"), queryHash, viewer)
		if e != nil {
			return nil, e
		}
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT id FROM projects_v2 WHERE state='active' AND ($1='' OR id::text>$1) AND ($3::text IS NULL OR owner_id=$3) ORDER BY id LIMIT $2) q", str(cursor, "startAfter"), 201, func() any {
			if portfolio {
				return q["ownerId"]
			}
			return nil
		}())
		if e != nil {
			return nil, e
		}
		scanned := rr
		if len(scanned) > 200 {
			scanned = scanned[:200]
		}
		visible := []Object{}
		for _, r := range scanned {
			item, e := s.directoryItem(ctx, tx, str(r, "id"), q, portfolio)
			if unavailable(e) {
				continue
			}
			if e != nil {
				return nil, e
			}
			if item != nil {
				visible = append(visible, item)
			}
		}
		b, e := identity.Canonical(visible)
		if e != nil {
			return nil, e
		}
		sourceHash := identity.Digest(b)
		last := str(cursor, "lastKey")
		if last != "" {
			found := false
			for _, item := range visible {
				found = found || str(item, "projectId") == last
			}
			if str(cursor, "sourceHash") != sourceHash || !found {
				return nil, fail("project_directory_sources_changed_retry", 409)
			}
		}
		remaining := []Object{}
		for _, item := range visible {
			if last == "" || str(item, "projectId") > last {
				remaining = append(remaining, item)
			}
		}
		sort.SliceStable(remaining, func(i, j int) bool { return str(remaining[i], "projectId") < str(remaining[j], "projectId") })
		limit := int(num(q, "limit"))
		items := remaining
		if len(items) > limit {
			items = items[:limit]
		}
		var next any
		if len(remaining) > limit {
			next, e = s.sealCursor(Object{"v": 2, "queryHash": queryHash, "viewerId": nullable(viewer), "startAfter": str(cursor, "startAfter"), "lastKey": items[len(items)-1]["projectId"], "sourceHash": sourceHash})
		} else if len(rr) > 200 {
			next, e = s.sealCursor(Object{"v": 2, "queryHash": queryHash, "viewerId": nullable(viewer), "startAfter": scanned[len(scanned)-1]["id"], "lastKey": nil, "sourceHash": nil})
		}
		if e != nil {
			return nil, e
		}
		return Object{"schemaVersion": 2, "items": items, "nextAfter": next, "computedAt": s.now(), "readOnly": true, "readingGrantsContact": false, "readingGrantsMembership": false, "coverage": Object{"windowLimited": len(rr) > 200, "scanWindowLimit": 200, "ordering": "project-id-within-window", "currentPublicSources": true, "globalCountProvided": false, "globalRanking": false}}, nil
	})
}
