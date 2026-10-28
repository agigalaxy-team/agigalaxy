package discovery

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type LegacyCandidateQuery struct {
	After, SubjectID, Query string
	Limit                   int
}

func legacyTerms(query string) []string {
	found := []string{}
	seen := map[string]bool{}
	for _, term := range strings.FieldsFunc(cases.Lower(language.English).String(query), jsSpace) {
		if !seen[term] {
			seen[term] = true
			found = append(found, term)
		}
	}
	return found
}
func (s *LegacyIndex) Candidates(ctx context.Context, kind string, q LegacyCandidateQuery) (Object, error) {
	if !slices.Contains([]string{"case", "history", "proof", "capsule", "worker", "hub"}, kind) || q.Limit < 1 || q.Limit > 200 || protocol.TextLength(q.Query) > 200 {
		return nil, errors.New("invalid index query")
	}
	age, e := s.maxAge()
	if e != nil {
		return nil, e
	}
	var enabled bool
	if e = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM search_index_control WHERE singleton AND endpoint=$1 AND enabled)", s.Endpoint).Scan(&enabled); e != nil {
		return nil, e
	}
	if !enabled {
		return Object{"enabled": false, "items": []Object{}}, nil
	}
	rows, e := s.Pool.Query(ctx, `SELECT source_id::text,source_version,metadata,built_at,valid_until FROM search_documents d WHERE source_type=$1 AND endpoint=$2 AND valid_until>$3 AND built_at>$4 AND ($5::uuid IS NULL OR source_id>$5) AND ($6::text IS NULL OR subject_id=$6) AND NOT EXISTS(SELECT 1 FROM deletion_requests pending WHERE pending.subject_id=d.subject_id AND pending.state IN ('requested','review-needed','approved','partial','primary-erased')) AND NOT EXISTS(SELECT 1 FROM unnest($7::text[]) term WHERE strpos(lower(d.search_text),term)=0) ORDER BY source_id LIMIT $8`, kind, s.Endpoint, s.now(), s.now().Add(-time.Duration(age)*time.Second), nullableString(q.After), nullableString(q.SubjectID), legacyTerms(q.Query), q.Limit+1)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, version string
		var raw []byte
		var built, until time.Time
		var metadata Object
		if e = rows.Scan(&id, &version, &raw, &built, &until); e != nil {
			return nil, e
		}
		if e = decode(raw, &metadata); e != nil {
			return nil, e
		}
		items = append(items, Object{"id": id, "sourceVersion": version, "metadata": metadata, "builtAt": iso(built.Unix()), "validUntil": iso(until.Unix())})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	truncated := len(items) > q.Limit
	if truncated {
		items = items[:q.Limit]
	}
	return Object{"enabled": true, "truncated": truncated, "items": items, "authority": "candidate-only; current-source-read-required"}, nil
}
