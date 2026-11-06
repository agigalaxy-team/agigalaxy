package communitygrowth

import (
	"context"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ensureDefaults(ctx context.Context, tx pgx.Tx) error {
	tag, e := tx.Exec(ctx, `INSERT INTO community_growth_initialized_v1(endpoint) VALUES($1) ON CONFLICT DO NOTHING`, s.Endpoint)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_growth_rules_v1(endpoint,rule_key,source_kind,label,experience,enabled,version,updated_at) VALUES
 ($1,'post','post','公开帖子',5,true,1,$2),($1,'reply','reply','公开回复',2,true,1,$2),
 ($1,'like_received','like','收到点赞',1,true,1,$2),($1,'recognition','recognition','社区认可',10,true,1,$2),
 ($1,'activity','activity','活动成果',10,true,1,$2) ON CONFLICT DO NOTHING`, s.Endpoint, s.now())
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_growth_levels_v1(endpoint,level,minimum,label) VALUES ($1,1,0,'初识'),($1,2,50,'参与'),($1,3,200,'贡献'),($1,4,500,'同行') ON CONFLICT DO NOTHING`, s.Endpoint)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_growth_rule_history_v1(endpoint,rule_key,version,snapshot,created_at) SELECT endpoint,rule_key,version,to_jsonb(r),$2 FROM community_growth_rules_v1 r WHERE endpoint=$1`, s.Endpoint, s.now())
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_growth_levels_history_v1(endpoint,version,snapshot,created_at) SELECT $1,1,jsonb_agg(to_jsonb(l) ORDER BY level),$2 FROM community_growth_levels_v1 l WHERE endpoint=$1`, s.Endpoint, s.now())
	return e
}
