package discovery

import (
	"context"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

type SearchEngine interface {
	Search(context.Context, SearchRequest, []string, string) (Object, error)
}
type IndexEngine interface {
	Upsert(context.Context, Document) error
	Remove(context.Context, string) error
}
type Runtime struct {
	Store           *Store
	Source          Source
	Meili           *Meilisearch
	Gorse           *Gorse
	Now             func() time.Time
	SearchQuality   *SearchQuality
	Recommendations *Recommendations
	OpenPanel       *OpenPanel
	Authority       *operationspermissions.BusinessAuthority
}

func (r *Runtime) now() int64 {
	if r.Now != nil {
		return r.Now().Unix()
	}
	return time.Now().Unix()
}
func (r *Runtime) Initialize(ctx context.Context) (Object, error) {
	if e := r.Store.Initialize(ctx); e != nil {
		return nil, e
	}
	if r.Meili != nil {
		if _, e := r.Meili.Configure(ctx); e != nil {
			return nil, e
		}
	}
	return r.Status(ctx)
}
func (r *Runtime) Status(ctx context.Context) (Object, error) {
	status, e := r.Store.Status(ctx)
	if e != nil {
		return nil, e
	}
	state := func(connected bool) string {
		if connected {
			return "configured"
		}
		return "not-connected"
	}
	return Object{"engines": Object{"openpanel": state(r.OpenPanel != nil), "gorse": state(r.Gorse != nil), "meilisearch": state(r.Meili != nil)}, "outbox": status, "retentionPolicy": "not-configured", "automaticPurge": false}, nil
}

var topics = map[string]bool{"technology": true, "arts": true, "learning": true, "life": true, "galaxy": true, "unclassified": true}

func parseSearch(input Object) (SearchRequest, error) {
	request := SearchRequest{After: 0, Limit: 20}
	for key := range input {
		if key != "query" && key != "topic" && key != "after" && key != "limit" {
			return request, invalid()
		}
	}
	raw, ok := input["query"].(string)
	if !ok {
		return request, invalid()
	}
	request.Query = strings.TrimFunc(raw, func(r rune) bool {
		return r == '\ufeff' || strings.ContainsRune(" \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000", r)
	})
	if codePointLength(request.Query) < 1 || codePointLength(request.Query) > 160 {
		return request, invalid()
	}
	if v, present := input["topic"]; present {
		topic, ok := v.(string)
		if !ok || !topics[topic] {
			return request, invalid()
		}
		request.Topic = topic
	}
	for _, entry := range []struct {
		key    string
		target *int
		lo, hi int64
	}{{"after", &request.After, 0, 10000}, {"limit", &request.Limit, 1, 30}} {
		if v, present := input[entry.key]; present {
			n, ok := integer(v)
			if !ok || n < entry.lo || n > entry.hi {
				return request, invalid()
			}
			*entry.target = int(n)
		}
	}
	return request, nil
}
func (r *Runtime) Search(ctx context.Context, input Object) (Object, error) {
	return r.search(ctx, input, nil, "")
}

// SearchForProfile is a trusted server consumer. HTTP must derive profile from
// its signed visitor/account session; the public query body cannot select it.
func (r *Runtime) SearchForProfile(ctx context.Context, input Object, profile string) (Object, error) {
	return r.search(ctx, input, nil, profile)
}
func (r *Runtime) SearchSelected(ctx context.Context, input Object, selected []Reference) (Object, error) {
	if len(selected) < 1 || len(selected) > 100 {
		return nil, fault.New("discovery_selected_scope_required", 403)
	}
	keys := []string{}
	seen := map[string]bool{}
	for _, ref := range selected {
		key, e := ItemKey(ref)
		if e != nil {
			return nil, e
		}
		if !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	return r.search(ctx, input, keys, "")
}
func (r *Runtime) search(ctx context.Context, input Object, itemKeys []string, profile string) (Object, error) {
	if r.Meili == nil {
		return nil, fail("discovery_search_not_connected")
	}
	request, e := parseSearch(input)
	if e != nil {
		return nil, e
	}
	nativeRequest := request
	var plan Object
	if r.SearchQuality != nil {
		plan, e = r.SearchQuality.PublicPlan(ctx)
		if e != nil {
			return nil, e
		}
	}
	nativeRequest.Limit = min(100, request.Limit*3)
	native, e := r.Meili.Search(ctx, nativeRequest, itemKeys, str(plan, "rankingMode"))
	if e != nil {
		return nil, e
	}
	hits, ok := native["hits"].([]any)
	if !ok {
		return nil, fail("discovery_engine_response_invalid")
	}
	items := []Object{}
	consumed := 0
	for _, value := range hits {
		consumed++
		candidate := object(value)
		if candidate == nil {
			return nil, fail("discovery_engine_response_invalid")
		}
		key := str(candidate, "id")
		if itemKeys != nil {
			allowed := false
			for _, selected := range itemKeys {
				allowed = allowed || key == selected
			}
			if !allowed {
				continue
			}
		}
		reference := ItemReference(key)
		if reference == nil {
			continue
		}
		document, e := r.Source.Load(ctx, *reference)
		if e != nil {
			return nil, e
		}
		if document == nil || document.IndexVersion != str(candidate, "version") {
			if e = r.Store.Enqueue(ctx, *reference); e != nil {
				return nil, e
			}
			continue
		}
		if request.Topic != "" && document.Topic != request.Topic {
			continue
		}
		items = append(items, View(document))
		if len(items) == request.Limit+1 {
			break
		}
	}
	scanLimited := len(items) <= request.Limit && len(hits) == nativeRequest.Limit
	var next any
	if len(items) > request.Limit {
		next = request.After + consumed - 1
	} else if scanLimited {
		next = request.After + consumed
	}
	if len(items) > request.Limit {
		items = items[:request.Limit]
	}
	now := r.now()
	result := Object{"items": items, "nextAfter": next, "scanLimited": scanLimited, "query": request.Query, "source": "meilisearch-community", "qualification": "current-anonymous-public-reader", "checkedAt": now, "readExpiresAt": now + 15}
	if r.SearchQuality != nil && profile != "" {
		afterPlan, e := r.SearchQuality.PublicPlan(ctx)
		if e != nil {
			return nil, e
		}
		measured := plan
		if !sameValue(plan["version"], afterPlan["version"]) || !sameValue(plan["rankingMode"], afterPlan["rankingMode"]) {
			measured = Object{"version": nil}
		}
		search, e := r.SearchQuality.IssueSearch(ctx, profile, request, result, measured)
		if e != nil {
			return nil, e
		}
		result["search"] = search
		for i, item := range items {
			item["search"] = Object{"requestId": search["requestId"], "position": i + 1}
		}
	}
	return result, nil
}
