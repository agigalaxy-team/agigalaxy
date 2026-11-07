package communitygrowth

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type rankingCounts struct {
	likes, recognitions int64
}

// RankingSignalsWithRules scores current forum facts in one snapshot. No
// author record, reputation result, or model participates in this read.
func (s *Service) RankingSignalsWithRules(ctx context.Context, candidates []discovery.CommunityCandidate, rules discovery.CommunityScoringRules) (map[string]discovery.CommunitySignal, error) {
	if s == nil || s.Pool == nil {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	if len(candidates) > 100 || rules.DiminishingScale <= 0 || rules.HalfLifeHours <= 0 {
		return nil, invalid()
	}
	result := make(map[string]discovery.CommunitySignal, len(candidates))
	if len(candidates) == 0 {
		return result, nil
	}
	refs := make([]publicObjectRef, 0, len(candidates))
	seen := make(map[string]bool, len(candidates))
	for i := range candidates {
		c := candidates[i]
		id, e := uuid.Parse(c.ID)
		if e != nil || c.Key == "" || seen[c.Key] || c.Kind != "post" && c.Kind != "reply" {
			return nil, invalid()
		}
		seen[c.Key] = true
		refs = append(refs, publicObjectRef{c.Kind, id.String()})
	}
	at := s.now()
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	views := eligibilityCache{}
	if e = s.prefetchWithin(ctx, tx, views, refs); e != nil {
		return nil, e
	}
	inputs := make([]Object, 0, len(candidates))
	postIDs := make([]string, 0, len(candidates))
	published := make(map[string]time.Time, len(candidates))
	for i, c := range candidates {
		ref := refs[i]
		view := views[ref.kind+":"+ref.id]
		if view == nil || str(view, "availability") != "available" || ref.kind == "reply" && str(view, "parentAvailability") != "available" {
			continue
		}
		version := str(view, "currentVersionId")
		if c.Kind == "reply" {
			revision, _ := integer(view["revision"])
			version = strconv.FormatInt(revision, 10)
		}
		if c.Version != "" && version != c.Version {
			continue
		}
		if created, ok := integer(view["createdAt"]); ok && created > 0 {
			published[c.Key] = time.Unix(created, 0)
		}
		inputs = append(inputs, Object{"key": c.Key, "kind": ref.kind, "id": ref.id})
		if c.Kind == "post" {
			postIDs = append(postIDs, ref.id)
		}
	}
	counts, e := s.rankingCountsWithin(ctx, tx, inputs)
	if e != nil {
		return nil, e
	}
	discussion := map[string]float64{}
	if rules.DiscussionWeight > 0 && len(postIDs) > 0 {
		discussion, e = s.discussionHeatWithin(ctx, tx, postIDs, at, rules.HalfLifeHours)
		if e != nil {
			return nil, e
		}
	}
	for i, c := range candidates {
		count, ok := counts[c.Key]
		if !ok {
			continue
		}
		heat := rules.FreshnessWeight * contentDecay(at, published[c.Key], rules.HalfLifeHours)
		if c.Kind == "post" {
			heat += rules.DiscussionWeight * discussion[refs[i].id]
		}
		result[c.Key] = discovery.CommunitySignal{
			Recognition:  contentRecognition(count, rules),
			Heat:         heat,
			Version:      rules.Version,
			CalculatedAt: at,
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return result, nil
}

func (s *Service) rankingCountsWithin(ctx context.Context, tx pgx.Tx, inputs []Object) (map[string]rankingCounts, error) {
	counts := make(map[string]rankingCounts, len(inputs))
	if len(inputs) == 0 {
		return counts, nil
	}
	data, e := json.Marshal(inputs)
	if e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, `
		SELECT c.key,
		 (SELECT count(*) FROM forum_reactions_v1 r JOIN community_accounts a ON a.id=r.account_id AND a.endpoint=$1
		  WHERE r.kind=c.kind AND r.object_id=c.id::uuid AND r.liked),
		 (SELECT count(*) FROM community_growth_recognitions_v1 g
		  WHERE g.endpoint=$1 AND g.object_kind=c.kind AND lower(g.object_id)=c.id AND g.active AND g.kind='content')
		FROM jsonb_to_recordset($2::jsonb) AS c(key text,kind text,id text)`, s.Endpoint, string(data))
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var count rankingCounts
		if e = rows.Scan(&key, &count.likes, &count.recognitions); e != nil {
			return nil, e
		}
		counts[key] = count
	}
	return counts, rows.Err()
}
