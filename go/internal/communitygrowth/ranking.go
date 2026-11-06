package communitygrowth

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RankingSignals combines real reactions with current, independently checked
// saved assessments. No model is called on the recommendation path.
func (s *Service) RankingSignals(ctx context.Context, candidates []discovery.CommunityCandidate) (map[string]discovery.CommunitySignal, error) {
	if s == nil || s.Pool == nil {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	if len(candidates) > 100 {
		return nil, invalid()
	}
	inputs := []Object{}
	seen := map[string]bool{}
	for _, x := range candidates {
		if (x.Kind != "post" && x.Kind != "reply") || x.Key == "" || seen[x.Key] {
			return nil, invalid()
		}
		if _, e := uuid.Parse(x.ID); e != nil {
			return nil, invalid()
		}
		if x.AuthorAccountID != "" {
			if _, e := uuid.Parse(x.AuthorAccountID); e != nil {
				return nil, invalid()
			}
		}
		seen[x.Key] = true
		inputs = append(inputs, Object{"key": x.Key, "kind": x.Kind, "id": x.ID})
	}
	data, e := json.Marshal(inputs)
	if e != nil {
		return nil, e
	}
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, `SELECT c.key,r.account_id::text FROM jsonb_to_recordset($2::jsonb) AS c(key text,kind text,id text) JOIN forum_reactions_v1 r ON r.kind=c.kind AND r.object_id=c.id::uuid AND r.liked JOIN community_accounts a ON a.id=r.account_id AND a.endpoint=$1 ORDER BY c.key,r.account_id`, s.Endpoint, string(data))
	if e != nil {
		return nil, e
	}
	reactions := map[string][]string{}
	for rows.Next() {
		var key, account string
		if e = rows.Scan(&key, &account); e != nil {
			rows.Close()
			return nil, e
		}
		reactions[key] = append(reactions[key], account)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	assessment := &AssessmentService{Service: s, ReadSourceWithin: s.AssessmentSourceWithin}
	type weight struct {
		value *float64
		id    string
	}
	cache := map[string]weight{}
	read := func(account, domain, purpose string) (weight, error) {
		key := jsonText([]string{account, domain, purpose})
		if v, ok := cache[key]; ok {
			return v, nil
		}
		value, id, e := assessment.CurrentWeightWithin(ctx, tx, account, domain, purpose)
		if e != nil {
			return weight{}, e
		}
		v := weight{value, id}
		cache[key] = v
		return v, nil
	}
	out := map[string]discovery.CommunitySignal{}
	for _, c := range candidates {
		domain := assessmentDomains([]string{c.Topic})[0]
		signal := discovery.CommunitySignal{ResultIDs: []string{}}
		if c.AuthorAccountID != "" {
			w, e := read(c.AuthorAccountID, domain, "contribution-impact")
			if e != nil {
				return nil, e
			}
			signal.Author = w.value
			if w.id != "" {
				signal.ResultIDs = append(signal.ResultIDs, w.id)
			}
		}
		for _, account := range reactions[c.Key] {
			w, e := read(account, domain, "evaluation-reference")
			if e != nil {
				return nil, e
			}
			amount := float64(1)
			if w.value != nil {
				amount = *w.value * 2
			}
			signal.Recognition += amount
			if w.id != "" {
				signal.ResultIDs = append(signal.ResultIDs, w.id)
			}
		}
		out[c.Key] = signal
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return out, nil
}
