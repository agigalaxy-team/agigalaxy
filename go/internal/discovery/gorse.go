package discovery

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

type Gorse struct{ nativeClient }

func NewGorse(origin, key string, options ClientOptions) (*Gorse, error) {
	if !serviceSecret(key) {
		return nil, fail("discovery_configuration_invalid")
	}
	client, e := newNative(origin, http.Header{"X-Api-Key": []string{key}}, options)
	if e != nil {
		return nil, e
	}
	return &Gorse{client}, nil
}
func (g *Gorse) Upsert(ctx context.Context, d Document) error {
	_, e := g.call(ctx, "/api/items", http.MethodPost, []Object{{"ItemId": d.ID, "IsHidden": false, "Categories": []string{d.Topic}, "Timestamp": iso(d.PublishedAt), "Labels": Object{"tags": d.Tags, "topic": d.Topic}, "Comment": ""}}, false)
	return e
}
func (g *Gorse) Remove(ctx context.Context, key string) error {
	_, e := g.call(ctx, "/api/item/"+url.PathEscape(key), http.MethodDelete, nil, true)
	return e
}

type RecommendationRequest struct {
	Mode  string `json:"mode"`
	Limit int    `json:"limit"`
	Topic string `json:"topic,omitempty"`
}

func (g *Gorse) Feedback(ctx context.Context, event Object) error {
	key := str(event, "itemKey")
	name := str(event, "name")
	if key == "" || name == "content-exposure" {
		return nil
	}
	types := map[string]string{"content-view": "view", "content-click": "click", "search-click": "click", "content-bookmark": "bookmark", "content-participate": "participate", "not-interested": "not-interested"}
	kind := types[name]
	if kind == "" {
		return nil
	}
	if _, e := g.call(ctx, "/api/user", http.MethodPost, Object{"UserId": event["profileId"], "Labels": []string{}, "Comment": ""}, false); e != nil {
		return e
	}
	_, e := g.call(ctx, "/api/feedback", http.MethodPut, []Object{{"FeedbackType": kind, "UserId": event["profileId"], "ItemId": key, "Timestamp": event["occurredAt"], "Value": 1}}, false)
	return e
}

func (g *Gorse) Recommend(ctx context.Context, input RecommendationRequest, profile string, offset int) ([]Object, error) {
	params := url.Values{"n": []string{strconv.Itoa(input.Limit)}, "offset": []string{strconv.Itoa(offset)}}
	if input.Topic != "" {
		params.Set("category", input.Topic)
	}
	path := "/api/recommend/" + url.PathEscape(profile)
	source := "gorse-recommendation"
	if input.Mode == "latest" {
		path = "/api/latest"
		source = "gorse-latest"
	}
	v, e := g.call(ctx, path+"?"+params.Encode(), http.MethodGet, nil, false)
	if e != nil {
		return nil, e
	}
	rows, ok := v.([]any)
	if !ok || len(rows) > input.Limit {
		return nil, fail("discovery_engine_response_invalid")
	}
	out := make([]Object, 0, len(rows))
	for _, row := range rows {
		id, ok := row.(string)
		if !ok {
			o := object(row)
			for _, field := range []string{"Id", "ItemId", "id"} {
				if o[field] != nil {
					id, ok = o[field].(string)
					break
				}
			}
		}
		if !ok {
			return nil, fail("discovery_engine_response_invalid")
		}
		out = append(out, Object{"id": id, "source": source})
	}
	return out, nil
}
