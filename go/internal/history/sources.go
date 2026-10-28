package history

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// Empty contexts are returned only when the original corresponding source set
// is absent. Existing unported sources require their owning current reader.
// Their metadata is never promoted into a permission or a successful Proof.
func (s *Service) context(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, kind string, reader AuthorizedSource) (any, error) {
	if reader != nil {
		return sourceView(ctx, tx, a, id, reader)
	}
	var present bool
	switch kind {
	case "capsule":
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM capsule_uses WHERE case_id=$1)`, id).Scan(&present); e != nil {
			return nil, e
		}
		if !present {
			return nil, nil
		}
	case "collaboration":
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assistance_requests WHERE case_id=$1)`, id).Scan(&present); e != nil {
			return nil, e
		}
		if !present {
			return Object{"version": 1, "coverage": "up-to-20-visible-links-from-200-candidates", "capabilityIds": []any{}, "items": []any{}, "capabilityVerified": false}, nil
		}
	case "moderation":
		empty := Object{"version": 1, "authority": "viewer-authorized-moderation", "automaticallyVerified": false, "items": []any{}, "coverage": "up-to-20-visible-reports; latest-10-visible-events-per-report"}
		if a == nil {
			return empty, nil
		}
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM moderation_reports WHERE case_id=$1)`, id).Scan(&present); e != nil {
			return nil, e
		}
		if !present {
			return empty, nil
		}
	}
	return nil, fault.New("history_source_reader_unavailable", 503)
}
func summarizeCI(proofs []any) (Object, error) {
	if len(proofs) > 1000 {
		return nil, fmt.Errorf("CI source summary exceeds bounded view")
	}
	type group struct {
		key                  string
		repo, run, attempt   any
		records              []any
		commits, conclusions map[string]bool
	}
	groups := map[string]*group{}
	records := 0
	for _, proof := range proofs {
		p := obj(obj(proof)["provenance"])
		if p == nil {
			continue
		}
		src := obj(p["source"])
		repo, run, attempt := num(src, "repositoryId"), num(src, "runId"), num(src, "attempt")
		if repo <= 0 || run <= 0 || attempt <= 0 {
			return nil, fmt.Errorf("invalid CI provenance source")
		}
		key := "github-actions:repository:" + strconv.FormatInt(repo, 10) + ":run:" + strconv.FormatInt(run, 10) + ":attempt:" + strconv.FormatInt(attempt, 10)
		if p["sourceKey"] != key || p["profile"] != "github-actions-provenance/1" || p["independentExecutionVerified"] != false {
			return nil, fmt.Errorf("invalid CI provenance view")
		}
		records++
		g := groups[key]
		if g == nil {
			g = &group{key: key, repo: src["repositoryId"], run: src["runId"], attempt: src["attempt"], records: []any{}, commits: map[string]bool{}, conclusions: map[string]bool{}}
			groups[key] = g
		}
		g.records = append(g.records, Object{"issuer": p["issuer"], "proofId": p["proofId"]})
		g.commits[str(src, "commit")] = true
		g.conclusions[fmt.Sprint(p["conclusion"])] = true
	}
	keys := []string{}
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	items := []any{}
	conflicting := 0
	for _, key := range keys {
		g := groups[key]
		conflicts := []string{}
		if len(g.commits) > 1 {
			conflicts = append(conflicts, "commit")
		}
		if len(g.conclusions) > 1 {
			conflicts = append(conflicts, "conclusion")
		}
		if len(conflicts) > 0 {
			conflicting++
		}
		items = append(items, Object{"sourceKey": key, "repositoryId": g.repo, "runId": g.run, "attempt": g.attempt, "records": g.records, "conflicts": conflicts})
	}
	return Object{"version": 1, "scope": "provided-visible-ci-proofs-only", "proofRecordCount": records, "sourceGroupCount": len(items), "duplicateProofRecordCount": records - len(items), "conflictingSourceGroupCount": conflicting, "independentlyVerifiedSourceCount": 0, "globalCountProvided": false, "groups": items}, nil
}
