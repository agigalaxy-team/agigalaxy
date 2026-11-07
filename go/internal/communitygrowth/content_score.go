package communitygrowth

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/jackc/pgx/v5"
)

func contentRecognition(count rankingCounts, rules discovery.CommunityScoringRules) float64 {
	scale := rules.DiminishingScale
	diminish := func(n int64) float64 { return scale * math.Log1p(float64(n)/scale) }
	return rules.LikeWeight*diminish(count.likes) + rules.ContentRecognitionWeight*diminish(count.recognitions)
}

func contentDecay(at, event time.Time, halfLifeHours float64) float64 {
	if event.IsZero() || event.After(at) {
		return 0
	}
	return math.Exp2(-at.Sub(event).Hours() / halfLifeHours)
}

type discussionReply struct {
	post, account, id string
	createdAt         time.Time
}

func (s *Service) discussionHeatWithin(ctx context.Context, tx pgx.Tx, posts []string, at time.Time, halfLifeHours float64) (map[string]float64, error) {
	heat := make(map[string]float64, len(posts))
	var latest [2]string
	var cursorPost, cursorAccount, cursorTime, cursorID any
	const batchSize = 100
	for {
		rows, e := tx.Query(ctx, `
			SELECT r.post_id::text,r.account_id::text,r.id::text,r.created_at
			FROM forum_replies_v1 r JOIN community_accounts a ON a.id=r.account_id AND a.endpoint=$2
			WHERE r.post_id=ANY($1::uuid[]) AND r.state='published' AND r.erased_at IS NULL
			  AND r.created_at<=$3 AND r.published_until>$3
			  AND ($4::uuid IS NULL OR (r.post_id,r.account_id,r.created_at,r.id)<($4,$5::uuid,$6::timestamptz,$7::uuid))
			  AND (NOT $9::boolean OR (r.post_id,r.account_id)<($4,$5))
			ORDER BY r.post_id DESC,r.account_id DESC,r.created_at DESC,r.id DESC LIMIT $8`,
			posts, s.Endpoint, at, cursorPost, cursorAccount, cursorTime, cursorID, batchSize, latest[0] == cursorPost && latest[1] == cursorAccount)
		if e != nil {
			return nil, e
		}
		batch := make([]discussionReply, 0, batchSize)
		refs := make([]publicObjectRef, 0, batchSize)
		fetched := 0
		for rows.Next() {
			fetched++
			var reply discussionReply
			if e = rows.Scan(&reply.post, &reply.account, &reply.id, &reply.createdAt); e != nil {
				rows.Close()
				return nil, e
			}
			cursorPost, cursorAccount, cursorTime, cursorID = reply.post, reply.account, reply.createdAt, reply.id
			if latest != [2]string{reply.post, reply.account} {
				batch = append(batch, reply)
				refs = append(refs, publicObjectRef{"reply", reply.id})
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		views := eligibilityCache{}
		if len(refs) > 0 {
			if e = s.prefetchWithin(ctx, tx, views, refs); e != nil {
				return nil, e
			}
		}
		for _, reply := range batch {
			key := [2]string{reply.post, reply.account}
			view := views["reply:"+reply.id]
			if latest == key || view == nil || str(view, "availability") != "available" || str(view, "parentAvailability") != "available" {
				continue
			}
			latest = key
			heat[reply.post] += contentDecay(at, reply.createdAt, halfLifeHours)
		}
		if fetched < batchSize {
			return heat, nil
		}
	}
}

func (s *Service) CommunityContentSampleWithin(ctx context.Context, tx pgx.Tx, priorRules, proposedRules *discovery.CommunityScoringRules) (Object, error) {
	const limit = 40
	rows, e := tx.Query(ctx, `
		SELECT p.id::text FROM forum_posts_v1 p JOIN community_accounts a ON a.id=p.account_id AND a.endpoint=$1
		WHERE p.state='published' AND p.erased_at IS NULL
		ORDER BY p.created_at DESC,p.id DESC LIMIT $2`, s.Endpoint, limit)
	if e != nil {
		return nil, e
	}
	refs := make([]publicObjectRef, 0, limit)
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		refs = append(refs, publicObjectRef{"post", id})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	views := eligibilityCache{}
	if e = s.prefetchWithin(ctx, tx, views, refs); e != nil {
		return nil, e
	}
	input := make([]Object, 0, len(refs))
	for _, ref := range refs {
		if str(views["post:"+ref.id], "availability") == "available" {
			input = append(input, Object{"key": ref.id, "kind": "post", "id": ref.id})
		}
	}
	counts, e := s.rankingCountsWithin(ctx, tx, input)
	if e != nil {
		return nil, e
	}
	var likes, recognitions int64
	var withLikes, withRecognitions int
	var priorTotal, proposedTotal float64
	compare := priorRules != nil && proposedRules != nil
	for _, item := range input {
		count := counts[str(item, "key")]
		likes += count.likes
		recognitions += count.recognitions
		if count.likes > 0 {
			withLikes++
		}
		if count.recognitions > 0 {
			withRecognitions++
		}
		if compare {
			priorTotal += contentRecognition(count, *priorRules)
			proposedTotal += contentRecognition(count, *proposedRules)
		}
	}
	sample := Object{
		"basis": "recent-qualified-public-posts", "sampledPosts": len(counts),
		"postsWithLikes": withLikes, "postsWithContentRecognition": withRecognitions,
		"likes": likes, "contentRecognitions": recognitions,
	}
	if len(counts) == 0 {
		return sample, nil
	}
	summary := fmt.Sprintf("近期 %d 篇符合公开条件的帖子，共 %d 次有效点赞、%d 次内容认可。", len(counts), likes, recognitions)
	if compare && likes+recognitions > 0 {
		priorAverage := priorTotal / float64(len(counts))
		proposedAverage := proposedTotal / float64(len(counts))
		sample["averageRecognitionBefore"], sample["averageRecognitionAfter"] = priorAverage, proposedAverage
		summary += fmt.Sprintf("按同一批帖子计算，平均认可分从 %.2f 调整为 %.2f。", priorAverage, proposedAverage)
	}
	sample["summary"] = summary
	return sample, nil
}
