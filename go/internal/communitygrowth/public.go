package communitygrowth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
	"time"
)

func (s *Service) publicAccount(ctx context.Context, tx pgx.Tx, viewer, account string) error {
	if _, e := uuid.Parse(account); e != nil {
		return invalid()
	}
	if s.PublicAccountWithin == nil {
		return fault.New("community_growth_profile_unavailable", 503)
	}
	profile, e := s.PublicAccountWithin(ctx, tx, viewer, account)
	if e != nil {
		return e
	}
	if profile == nil {
		return fault.New("not_found", 404)
	}
	return nil
}

// ReadEligibleWithin uses the anonymous community read. Nil means unavailable.
func (s *Service) ReadEligibleWithin(ctx context.Context, tx pgx.Tx, kind, id string) (Object, error) {
	if s.Forum == nil || s.Forum.Endpoint != s.Endpoint {
		return nil, fault.New("community_growth_forum_unavailable", 503)
	}
	if (kind != "post" && kind != "reply") || id == "" {
		return nil, nil
	}
	view, e := s.Forum.ReadPublicDiscoveryWithin(ctx, tx, kind, id, s.WorkerPublicRead)
	if e != nil {
		if fault.Status(e) == 404 {
			return nil, nil
		}
		return nil, e
	}
	if str(view, "availability") != "available" || (kind == "reply" && str(view, "parentAvailability") != "available") {
		return nil, nil
	}
	return view, nil
}

type eligibilityCache map[string]Object

// publicTransaction uses one consistent snapshot for all batches in a response.
func (s *Service) publicTransaction(ctx context.Context, fn func(pgx.Tx) (Object, error)) (Object, error) {
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	out, e := fn(tx)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return out, nil
}

// readDeadline is a known source cutoff, not a complete authorization lease.
func readDeadline(current int64, view Object) int64 {
	var v int64
	switch n := view["readExpiresAt"].(type) {
	case int64:
		v = n
	case int:
		v = int64(n)
	case float64:
		v = int64(n)
	case json.Number:
		v, _ = n.Int64()
	}
	if v > 0 && (current == 0 || v < current) {
		return v
	}
	return current
}
func deadlineValue(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

type publicObjectRef struct{ kind, id string }

func (s *Service) prefetchWithin(ctx context.Context, tx pgx.Tx, cache eligibilityCache, objects []publicObjectRef) error {
	if s.Forum == nil || s.Forum.Endpoint != s.Endpoint {
		return fault.New("community_growth_forum_unavailable", 503)
	}
	refs := []community.DiscoveryReference{}
	seen := map[string]bool{}
	for _, r := range objects {
		key := r.kind + ":" + r.id
		if _, ok := cache[key]; ok {
			continue
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		if r.kind != "post" && r.kind != "reply" {
			cache[key] = nil
			continue
		}
		u, e := uuid.Parse(r.id)
		if e != nil || !strings.EqualFold(u.String(), r.id) || u.Version() < 1 || u.Version() > 8 || u.Variant() != uuid.RFC4122 {
			cache[key] = nil
			continue
		}
		refs = append(refs, community.DiscoveryReference{Kind: r.kind, ID: r.id})
	}
	for start := 0; start < len(refs); start += 100 {
		end := start + 100
		if end > len(refs) {
			end = len(refs)
		}
		views, e := s.Forum.ReadPublicDiscoverySummaryBatchWithin(ctx, tx, refs[start:end])
		if e != nil {
			return e
		}
		for i, r := range refs[start:end] {
			cache[r.Kind+":"+r.ID] = views[i]
		}
	}
	return nil
}

type sourceFacts struct {
	authors map[string]string
	likes   map[string]bool
}

func (s *Service) batchSourceFacts(ctx context.Context, tx pgx.Tx, batch []growthRow) (sourceFacts, error) {
	f := sourceFacts{authors: map[string]string{}, likes: map[string]bool{}}
	posts, replies, actors, kinds, objects := []string{}, []string{}, []string{}, []string{}, []string{}
	for _, r := range batch {
		if r.Kind != "post" && r.Kind != "reply" && r.Kind != "like" {
			continue
		}
		if _, e := uuid.Parse(r.ObjectID); e != nil {
			continue
		}
		if r.ObjectKind == "post" {
			posts = append(posts, r.ObjectID)
		} else if r.ObjectKind == "reply" {
			replies = append(replies, r.ObjectID)
		} else {
			continue
		}
		if r.Kind == "like" {
			parts := strings.Split(r.ID, ":")
			if len(parts) != 3 || parts[0] != r.ObjectKind || parts[1] != r.ObjectID {
				continue
			}
			if _, e := uuid.Parse(parts[2]); e != nil {
				continue
			}
			actors = append(actors, parts[2])
			kinds = append(kinds, r.ObjectKind)
			objects = append(objects, r.ObjectID)
		}
	}
	rows, e := tx.Query(ctx, `SELECT 'post',id::text,account_id::text FROM forum_posts_v1 WHERE id=ANY($1::uuid[]) UNION ALL SELECT 'reply',id::text,account_id::text FROM forum_replies_v1 WHERE id=ANY($2::uuid[])`, posts, replies)
	if e != nil {
		return f, e
	}
	for rows.Next() {
		var kind, id string
		var account *string
		if e = rows.Scan(&kind, &id, &account); e != nil {
			rows.Close()
			return f, e
		}
		if account != nil {
			f.authors[kind+":"+id] = *account
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return f, e
	}
	rows, e = tx.Query(ctx, `SELECT r.kind,r.object_id::text,r.account_id::text FROM unnest($1::uuid[],$2::text[],$3::uuid[]) AS wanted(account_id,kind,object_id) JOIN forum_reactions_v1 r USING(account_id,kind,object_id) JOIN community_accounts a ON a.id=r.account_id AND a.endpoint=$4 WHERE r.liked`, actors, kinds, objects, s.Endpoint)
	if e != nil {
		return f, e
	}
	for rows.Next() {
		var kind, id, actor string
		if e = rows.Scan(&kind, &id, &actor); e != nil {
			rows.Close()
			return f, e
		}
		f.likes[ReactionSourceID(kind, id, actor)] = true
	}
	e = rows.Err()
	rows.Close()
	return f, e
}
func (f sourceFacts) current(account string, r growthRow, view Object) bool {
	if view == nil {
		return false
	}
	if r.Kind != "post" && r.Kind != "reply" && r.Kind != "like" {
		return true
	}
	if str(view, "authorAccountId") != account || f.authors[r.ObjectKind+":"+r.ObjectID] != account {
		return false
	}
	if r.Kind == "like" {
		return f.likes[r.ID]
	}
	return r.Kind == r.ObjectKind && r.ID == r.ObjectID
}

func (s *Service) eligibleWithin(ctx context.Context, tx pgx.Tx, cache eligibilityCache, kind, id string) (Object, error) {
	key := kind + ":" + id
	if view, found := cache[key]; found {
		return view, nil
	}
	view, e := s.ReadEligibleWithin(ctx, tx, kind, id)
	if e != nil {
		return nil, e
	}
	cache[key] = view
	return view, nil
}

type growthRow struct {
	Kind, ID, Rule, Title, ObjectKind, ObjectID, OpaqueID string
	Domains                                               []string
	Experience                                            int64
	At                                                    time.Time
}

func (r growthRow) cursor() cursor { return cursor{r.At, r.OpaqueID} }
func (r growthRow) item() Object {
	return Object{"sourceKind": r.Kind, "sourceId": r.OpaqueID, "title": r.Title, "objectKind": r.ObjectKind, "objectId": r.ObjectID, "domains": r.Domains, "experience": r.Experience, "occurredAt": r.At}
}
func (s *Service) sourceRows(ctx context.Context, tx pgx.Tx, account string, c *cursor, limit int) ([]growthRow, error) {
	var at any
	var id string
	if c != nil {
		at = c.At
		id = c.ID
	}
	rows, e := tx.Query(ctx, `SELECT x.source_kind,x.source_id,x.rule_key,x.title,x.object_kind,x.object_id,x.domains,r.experience,x.occurred_at,x.id::text FROM community_growth_sources_v1 x JOIN community_growth_rules_v1 r ON r.endpoint=x.endpoint AND r.rule_key=x.rule_key AND r.source_kind=x.source_kind WHERE x.endpoint=$1 AND x.account_id=$2 AND x.active AND r.enabled AND x.source_kind<>'evaluation' AND ($3::timestamptz IS NULL OR (x.occurred_at,x.id)<($3,$4::uuid)) ORDER BY x.occurred_at DESC,x.id DESC LIMIT $5`, s.Endpoint, account, at, func() any {
		if id == "" {
			return nil
		}
		return id
	}(), limit)
	if e != nil {
		return nil, e
	}
	out := []growthRow{}
	for rows.Next() {
		var r growthRow
		if e = rows.Scan(&r.Kind, &r.ID, &r.Rule, &r.Title, &r.ObjectKind, &r.ObjectID, &r.Domains, &r.Experience, &r.At, &r.OpaqueID); e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, r)
	}
	e = rows.Err()
	rows.Close()
	return out, e
}

// currentGrowthSourceWithin checks live ownership and relationship state, so a
// delayed projection cannot extend a cancelled reaction or former authorship.
func (s *Service) currentGrowthSourceWithin(ctx context.Context, tx pgx.Tx, account string, r growthRow, view Object) (bool, error) {
	if r.Kind == "evaluation" {
		if view == nil || str(view, "availability") != "available" || (r.ObjectKind == "reply" && str(view, "parentAvailability") != "available") {
			return false, nil
		}
		pieces := strings.Split(r.ID, ":")
		if len(pieces) != 3 || pieces[0] != r.ObjectKind || pieces[1] != r.ObjectID || pieces[2] != account {
			return false, nil
		}
		if _, e := uuid.Parse(pieces[2]); e != nil {
			return false, nil
		}
		var liked bool
		e := tx.QueryRow(ctx, `SELECT r.liked FROM forum_reactions_v1 r JOIN community_accounts a ON a.id=r.account_id WHERE r.account_id=$1 AND r.kind=$2 AND r.object_id=$3 AND a.endpoint=$4`, account, r.ObjectKind, r.ObjectID, s.Endpoint).Scan(&liked)
		if noRows(e) {
			return false, nil
		}
		return liked, e
	}
	if r.Kind != "post" && r.Kind != "reply" && r.Kind != "like" {
		return true, nil
	}
	if str(view, "authorAccountId") != account {
		return false, nil
	}
	if (r.Kind == "post" || r.Kind == "reply") && (r.ID != r.ObjectID || r.Kind != r.ObjectKind) {
		return false, nil
	}
	var author *string
	q := `SELECT account_id::text FROM forum_posts_v1 WHERE id=$1`
	if r.ObjectKind == "reply" {
		q = `SELECT account_id::text FROM forum_replies_v1 WHERE id=$1`
	} else if r.ObjectKind != "post" {
		return false, nil
	}
	e := tx.QueryRow(ctx, q, r.ObjectID).Scan(&author)
	if noRows(e) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if author == nil || *author != account {
		return false, nil
	}
	if r.Kind != "like" {
		return true, nil
	}
	pieces := strings.Split(r.ID, ":")
	if len(pieces) != 3 || pieces[0] != r.ObjectKind || pieces[1] != r.ObjectID {
		return false, nil
	}
	if _, e = uuid.Parse(pieces[2]); e != nil {
		return false, nil
	}
	var liked bool
	e = tx.QueryRow(ctx, `SELECT r.liked FROM forum_reactions_v1 r JOIN community_accounts a ON a.id=r.account_id WHERE r.account_id=$1 AND r.kind=$2 AND r.object_id=$3 AND a.endpoint=$4`, pieces[2], r.ObjectKind, r.ObjectID, s.Endpoint).Scan(&liked)
	if noRows(e) {
		return false, nil
	}
	return liked, e
}

func (s *Service) PublicOverview(ctx context.Context, viewer, account string) (Object, error) {
	return s.publicTransaction(ctx, func(tx pgx.Tx) (Object, error) {
		if e := s.publicAccount(ctx, tx, viewer, account); e != nil {
			return nil, e
		}
		if e := s.ensureDefaults(ctx, tx); e != nil {
			return nil, e
		}
		cache := eligibilityCache{}
		var c *cursor
		var experience int64
		var deadline int64
		domainTotals := map[string]int64{}
		for {
			batch, e := s.sourceRows(ctx, tx, account, c, 100)
			if e != nil {
				return nil, e
			}
			if len(batch) == 0 {
				break
			}
			refs := make([]publicObjectRef, 0, len(batch))
			for _, r := range batch {
				refs = append(refs, publicObjectRef{r.ObjectKind, r.ObjectID})
			}
			if e = s.prefetchWithin(ctx, tx, cache, refs); e != nil {
				return nil, e
			}
			facts, e := s.batchSourceFacts(ctx, tx, batch)
			if e != nil {
				return nil, e
			}
			for _, r := range batch {
				ok := cache[r.ObjectKind+":"+r.ObjectID]
				if ok == nil {
					continue
				}
				if !facts.current(account, r, ok) {
					continue
				}
				deadline = readDeadline(deadline, ok)
				experience += r.Experience
				seen := map[string]bool{}
				for _, d := range r.Domains {
					if !seen[d] {
						domainTotals[d] += r.Experience
						seen[d] = true
					}
				}
			}
			last := batch[len(batch)-1].cursor()
			c = &last
			if len(batch) < 100 {
				break
			}
		}
		var level Object
		if e := tx.QueryRow(ctx, `SELECT jsonb_build_object('level',level,'label',label,'minimum',minimum) FROM community_growth_levels_v1 WHERE endpoint=$1 AND minimum<=$2 ORDER BY minimum DESC LIMIT 1`, s.Endpoint, experience).Scan(&level); e != nil {
			return nil, e
		}
		var next Object
		e := tx.QueryRow(ctx, `SELECT jsonb_build_object('level',level,'label',label,'minimum',minimum) FROM community_growth_levels_v1 WHERE endpoint=$1 AND minimum>$2 ORDER BY minimum LIMIT 1`, s.Endpoint, experience).Scan(&next)
		if e != nil && !noRows(e) {
			return nil, e
		}
		domains := []Object{}
		for domain, total := range domainTotals {
			domains = append(domains, Object{"domain": domain, "experience": total})
		}
		sort.Slice(domains, func(i, j int) bool {
			a, b := domains[i]["experience"].(int64), domains[j]["experience"].(int64)
			if a != b {
				return a > b
			}
			return domains[i]["domain"].(string) < domains[j]["domain"].(string)
		})
		rows, e := tx.Query(ctx, `SELECT jsonb_build_object('id',x.id,'name',d.name,'description',d.description,'objectKind',x.object_kind,'objectId',x.object_id,'domain',x.domain,'reason',x.reason,'createdAt',x.created_at) FROM community_growth_recognitions_v1 x JOIN community_growth_definitions_v1 d ON d.endpoint=x.endpoint AND d.id=x.definition_id WHERE x.endpoint=$1 AND x.account_id=$2 AND x.kind='honor' AND x.active ORDER BY x.created_at DESC,x.id DESC`, s.Endpoint, account)
		if e != nil {
			return nil, e
		}
		allHonors, e := rowsObjects(rows)
		if e != nil {
			return nil, e
		}
		honors := []Object{}
		honorRefs := make([]publicObjectRef, 0, len(allHonors))
		for _, h := range allHonors {
			honorRefs = append(honorRefs, publicObjectRef{str(h, "objectKind"), str(h, "objectId")})
		}
		if e = s.prefetchWithin(ctx, tx, cache, honorRefs); e != nil {
			return nil, e
		}
		for _, honor := range allHonors {
			ok := cache[str(honor, "objectKind")+":"+str(honor, "objectId")]
			if ok != nil {
				deadline = readDeadline(deadline, ok)
				honors = append(honors, honor)
			}
		}
		return Object{"accountId": account, "experience": experience, "level": level, "nextLevel": next, "domains": domains, "honors": honors, "readExpiresAt": deadlineValue(deadline)}, nil
	})
}

type cursor struct {
	At time.Time `json:"t"`
	ID string    `json:"i"`
}

func (s *Service) PublicContributions(ctx context.Context, viewer, account string, limit int, after string) (Object, error) {
	if limit == 0 {
		limit = 30
	}
	if limit < 1 || limit > 100 {
		return nil, invalid()
	}
	var initial *cursor
	if after != "" {
		var c cursor
		b, e := base64.RawURLEncoding.DecodeString(after)
		if e != nil || json.Unmarshal(b, &c) != nil || c.At.IsZero() || c.ID == "" {
			return nil, invalid()
		}
		if _, e = uuid.Parse(c.ID); e != nil {
			return nil, invalid()
		}
		initial = &c
	}
	return s.publicTransaction(ctx, func(tx pgx.Tx) (Object, error) {
		if e := s.publicAccount(ctx, tx, viewer, account); e != nil {
			return nil, e
		}
		if e := s.ensureDefaults(ctx, tx); e != nil {
			return nil, e
		}
		cache := eligibilityCache{}
		items := []Object{}
		var deadline int64
		var last cursor
		scan := initial
		more := false
		for {
			batch, e := s.sourceRows(ctx, tx, account, scan, 100)
			if e != nil {
				return nil, e
			}
			if len(batch) == 0 {
				break
			}
			refs := make([]publicObjectRef, 0, len(batch))
			for _, r := range batch {
				refs = append(refs, publicObjectRef{r.ObjectKind, r.ObjectID})
			}
			if e = s.prefetchWithin(ctx, tx, cache, refs); e != nil {
				return nil, e
			}
			facts, e := s.batchSourceFacts(ctx, tx, batch)
			if e != nil {
				return nil, e
			}
			for _, r := range batch {
				ok := cache[r.ObjectKind+":"+r.ObjectID]
				if ok == nil {
					continue
				}
				if !facts.current(account, r, ok) {
					continue
				}
				deadline = readDeadline(deadline, ok)
				if len(items) == limit {
					more = true
					break
				}
				item := r.item()
				if r.Kind == "post" || r.Kind == "reply" || r.Kind == "like" {
					item["title"] = ""
					if payload, valid := ok["payload"].(map[string]any); valid && r.ObjectKind == "post" {
						item["title"] = str(payload, "title")
					}
				}
				items = append(items, item)
				last = r.cursor()
			}
			if more || len(batch) < 100 {
				break
			}
			c := batch[len(batch)-1].cursor()
			scan = &c
		}
		var next any
		if more {
			b, _ := json.Marshal(last)
			next = base64.RawURLEncoding.EncodeToString(b)
		}
		return Object{"accountId": account, "items": items, "nextAfter": next, "readExpiresAt": deadlineValue(deadline)}, nil
	})
}
