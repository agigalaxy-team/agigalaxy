package discovery

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Recommendations struct {
	Pool              *pgxpool.Pool
	Endpoint          string
	Authority         *operationspermissions.BusinessAuthority
	Source            Source
	OpenPanel         *OpenPanel
	Now               func() time.Time
	preparedAuthorize func(context.Context, pgx.Tx) (Actor, error)
}

func (s *Recommendations) business() *SearchQuality {
	return &SearchQuality{Pool: s.Pool, Endpoint: s.Endpoint, Authority: s.Authority, Now: s.Now, preparedAuthorize: s.preparedAuthorize}
}
func (s *Recommendations) now() time.Time { return s.business().now() }
func (s *Recommendations) policy(ctx context.Context, db queryReader) (Object, error) {
	row, e := rowObject(ctx, db, "SELECT to_jsonb(p) FROM operations_recommendation_policy_v1 p WHERE endpoint=$1", s.Endpoint)
	if e != nil {
		return nil, e
	}
	return policyView(row), nil
}
func (s *Recommendations) catalog(ctx context.Context, db candidateReader) ([]Object, error) {
	topicCatalog := (&community.Service{}).Topics()
	categories := append([]Object{}, topicCatalog["items"].([]Object)...)
	categories = append(categories, object(topicCatalog["unclassified"]))
	out := []Object{}
	for _, topic := range categories {
		out = append(out, Object{"key": "category:" + str(topic, "id"), "id": nil, "label": topic["label"], "kind": "category", "version": int64(0), "enabled": true, "mapping": Object{"categories": []string{str(topic, "id")}, "tagIds": []string{}, "queryTerms": []string{}}, "source": "forum-category"})
	}
	rows, e := db.Query(ctx, "SELECT id::text,name,revision,enabled FROM operations_forum_tags_v1 WHERE endpoint=$1 ORDER BY name,id", s.Endpoint)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id, name string
		var revision int64
		var enabled bool
		if e = rows.Scan(&id, &name, &revision, &enabled); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, Object{"key": "tag:" + id, "id": id, "label": name, "kind": "tag", "version": revision, "enabled": enabled, "mapping": Object{"categories": []string{}, "tagIds": []string{id}, "queryTerms": []string{}}, "source": "forum-tag"})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	rows, e = db.Query(ctx, "SELECT to_jsonb(t) FROM operations_recommendation_themes_v1 t WHERE endpoint=$1 ORDER BY label,id", s.Endpoint)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var raw []byte
		var row Object
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return nil, e
		}
		if e = decode(raw, &row); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, themeView(row))
	}
	e = rows.Err()
	rows.Close()
	return out, e
}
func (s *Recommendations) PublicPlan(ctx context.Context, profile string) (RecommendationPlan, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return RecommendationPlan{}, e
	}
	defer tx.Rollback(context.Background())
	policy, e := s.policy(ctx, tx)
	if e != nil {
		return RecommendationPlan{}, e
	}
	themes, e := s.catalog(ctx, tx)
	if e != nil {
		return RecommendationPlan{}, e
	}
	exposed := map[string]bool{}
	if policy["enabled"] == true && object(policy["controls"])["avoidRepetition"] == true {
		rows, e := tx.Query(ctx, `WITH latest AS (SELECT r.id::text AS id FROM discovery_usage_events_v1 e JOIN discovery_recommendation_requests_v1 r ON r.endpoint=e.endpoint AND r.profile_id=e.profile_id AND r.id::text=e.payload->'recommendation'->>'requestId' WHERE e.endpoint=$1 AND e.profile_id=$2 AND e.name='content-exposure' ORDER BY r.sequence DESC,e.created_at DESC LIMIT 1) SELECT payload->>'itemKey' AS item_key FROM discovery_usage_events_v1 e,latest WHERE endpoint=$1 AND profile_id=$2 AND name='content-exposure' AND payload->'recommendation'->>'requestId'=latest.id`, s.Endpoint, profile)
		if e != nil {
			return RecommendationPlan{}, e
		}
		for rows.Next() {
			var key *string
			if e = rows.Scan(&key); e != nil {
				rows.Close()
				return RecommendationPlan{}, e
			}
			if key != nil {
				exposed[*key] = true
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return RecommendationPlan{}, e
		}
	}
	return RecommendationPlan{Policy: policy, Themes: themes, PreviouslyExposed: exposed}, tx.Commit(ctx)
}
func (s *Recommendations) issue(ctx context.Context, profile, mode string, candidates []recommendationCandidate, plan RecommendationPlan) (Object, error) {
	id := uuid.NewString()
	var version any
	if mode == "personalized" && plan.Policy["enabled"] == true {
		version = plan.Policy["version"]
	}
	placement := "home-public-recommendations"
	items := []Object{}
	for i, candidate := range candidates {
		document := candidate.Document
		items = append(items, Object{"key": document.ID, "kind": document.Kind, "id": document.SourceID, "sourceVersion": document.Version, "position": i + 1, "candidateSource": candidate.Candidate["source"], "themeKeys": themeKeys(plan.Themes, document)})
	}
	_, e := s.Pool.Exec(ctx, "INSERT INTO discovery_recommendation_requests_v1(endpoint,id,profile_id,policy_version,mode,placement,items,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", s.Endpoint, id, profile, version, mode, placement, jsonString(items), s.now())
	if e != nil {
		return nil, e
	}
	return Object{"requestId": id, "policyVersion": version, "placement": placement}, nil
}
func (s *Recommendations) Evidence(ctx context.Context, profile string, content Object, id string) (Object, error) {
	row, e := rowObject(ctx, s.Pool, "SELECT jsonb_build_object('policy_version',policy_version,'placement',placement,'items',items) FROM discovery_recommendation_requests_v1 WHERE endpoint=$1 AND id=$2 AND profile_id=$3", s.Endpoint, id, profile)
	if e != nil {
		return nil, e
	}
	for _, item := range objects(row["items"]) {
		if item["kind"] == content["kind"] && item["id"] == content["id"] && item["sourceVersion"] == content["version"] {
			return Object{"requestId": id, "policyVersion": row["policy_version"], "placement": row["placement"], "position": item["position"], "candidateSource": item["candidateSource"], "themeKeys": item["themeKeys"]}, nil
		}
	}
	return nil, qualityFailure("discovery_recommendation_reference_invalid", 403)
}
