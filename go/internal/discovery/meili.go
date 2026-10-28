package discovery

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

var indexName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

type Meilisearch struct {
	nativeClient
	index string
}

func NewMeilisearch(origin, key, index string, options ClientOptions) (*Meilisearch, error) {
	if index == "" {
		index = "galaxy_public_community"
	}
	if !indexName.MatchString(index) || !serviceSecret(key) {
		return nil, fail("discovery_configuration_invalid")
	}
	client, e := newNative(origin, http.Header{"Authorization": []string{"Bearer " + key}}, options)
	if e != nil {
		return nil, e
	}
	return &Meilisearch{client, index}, nil
}
func (m *Meilisearch) task(ctx context.Context, value any) (Object, error) {
	id, ok := integer(object(value)["taskUid"])
	if !ok {
		return nil, fail("discovery_engine_response_invalid")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	for {
		result, e := m.call(ctx, "/tasks/"+strconv.FormatInt(id, 10), http.MethodGet, nil, false)
		if e != nil {
			return nil, e
		}
		task := object(result)
		switch str(task, "status") {
		case "succeeded":
			return task, nil
		case "failed", "canceled":
			return nil, fail("discovery_index_task_failed")
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fail("discovery_index_task_pending")
		case <-timer.C:
		}
	}
}
func (m *Meilisearch) Configure(ctx context.Context) (Object, error) {
	existing, e := m.call(ctx, "/indexes/"+m.index, http.MethodGet, nil, true)
	if e != nil {
		return nil, e
	}
	if existing != nil {
		return Object{"preserved": true}, nil
	}
	task, e := m.call(ctx, "/indexes", http.MethodPost, Object{"uid": m.index, "primaryKey": "id"}, false)
	if e != nil {
		return nil, e
	}
	if _, e = m.task(ctx, task); e != nil {
		return nil, e
	}
	task, e = m.call(ctx, "/indexes/"+m.index+"/settings", http.MethodPatch, Object{"searchableAttributes": []string{"title", "body", "topic", "tags"}, "displayedAttributes": []string{"id", "kind", "sourceId", "version"}, "filterableAttributes": []string{"id", "kind", "topic"}, "sortableAttributes": []string{"publishedAt"}, "rankingRules": []string{"words", "typo", "proximity", "attribute", "sort", "exactness"}}, false)
	if e != nil {
		return nil, e
	}
	return m.task(ctx, task)
}
func (m *Meilisearch) Upsert(ctx context.Context, d Document) error {
	value, e := m.call(ctx, "/indexes/"+m.index+"/documents", http.MethodPost, []Object{{"id": d.ID, "kind": d.Kind, "sourceId": d.SourceID, "version": d.IndexVersion, "title": d.Title, "body": d.Body, "topic": d.Topic, "tags": d.Tags, "publishedAt": d.PublishedAt}}, false)
	if e != nil {
		return e
	}
	_, e = m.task(ctx, value)
	return e
}
func (m *Meilisearch) Remove(ctx context.Context, key string) error {
	value, e := m.call(ctx, "/indexes/"+m.index+"/documents/"+url.PathEscape(key), http.MethodDelete, nil, false)
	if e != nil {
		return e
	}
	_, e = m.task(ctx, value)
	return e
}

type SearchRequest struct {
	Query string `json:"query"`
	Topic string `json:"topic,omitempty"`
	After int    `json:"after"`
	Limit int    `json:"limit"`
}

func (m *Meilisearch) Settings(ctx context.Context) (Object, error) {
	v, e := m.call(ctx, "/indexes/"+m.index+"/settings", http.MethodGet, nil, false)
	if e != nil {
		return nil, e
	}
	return controlledSettings(object(v))
}
func (m *Meilisearch) SubmitSettings(ctx context.Context, settings Object) (int64, error) {
	clean, e := controlledSettings(settings)
	if e != nil {
		return 0, e
	}
	v, e := m.call(ctx, "/indexes/"+m.index+"/settings", http.MethodPatch, clean, false)
	if e != nil {
		return 0, e
	}
	id, ok := integer(object(v)["taskUid"])
	if !ok || id < 0 || id > 9007199254740991 {
		return 0, fail("discovery_engine_response_invalid")
	}
	return id, nil
}

type SettingsTask struct {
	ID       int64  `json:"id"`
	Status   string `json:"status"`
	Settings Object `json:"settings"`
}
type SettingsTaskPage struct {
	Items    []SettingsTask `json:"items"`
	Complete bool           `json:"complete"`
}

func (m *Meilisearch) validateSettingsTask(value Object) (SettingsTask, error) {
	id, ok := integer(value["uid"])
	status := str(value, "status")
	if !ok || id < 0 || id > 9007199254740991 || str(value, "type") != "settingsUpdate" || str(value, "indexUid") != m.index || (status != "enqueued" && status != "processing" && status != "succeeded" && status != "failed" && status != "canceled") {
		return SettingsTask{}, fail("discovery_engine_response_invalid")
	}
	var settings Object
	details := object(value["details"])
	_, hasSynonyms := details["synonyms"]
	_, hasRules := details["rankingRules"]
	if hasSynonyms && hasRules {
		var e error
		settings, e = controlledSettings(details)
		if e != nil {
			return SettingsTask{}, e
		}
	}
	return SettingsTask{ID: id, Status: status, Settings: settings}, nil
}
func (m *Meilisearch) SettingsTask(ctx context.Context, id int64) (*SettingsTask, error) {
	if id < 0 || id > 9007199254740991 {
		return nil, settingsInvalid()
	}
	v, e := m.call(ctx, "/tasks/"+strconv.FormatInt(id, 10), http.MethodGet, nil, true)
	if e != nil || v == nil {
		return nil, e
	}
	task, e := m.validateSettingsTask(object(v))
	if e != nil {
		return nil, e
	}
	if task.ID != id {
		return nil, fail("discovery_engine_response_invalid")
	}
	return &task, nil
}
func (m *Meilisearch) SettingsTasks(ctx context.Context, after int64, limit int, pending bool) (SettingsTaskPage, error) {
	if after < -1 || after > 9007199254740991 || limit < 1 || limit > 100 {
		return SettingsTaskPage{}, settingsInvalid()
	}
	params := url.Values{"indexUids": []string{m.index}, "types": []string{"settingsUpdate"}, "limit": []string{strconv.Itoa(limit)}}
	if pending {
		params.Set("statuses", "enqueued,processing")
	}
	v, e := m.call(ctx, "/tasks?"+params.Encode(), http.MethodGet, nil, false)
	if e != nil {
		return SettingsTaskPage{}, e
	}
	o := object(v)
	if _, exists := o["next"]; !exists {
		return SettingsTaskPage{}, fail("discovery_engine_response_invalid")
	}
	rows, ok := o["results"].([]any)
	if !ok || len(rows) > limit {
		return SettingsTaskPage{}, fail("discovery_engine_response_invalid")
	}
	if o["next"] != nil {
		n, ok := integer(o["next"])
		if !ok || n < -9007199254740991 || n > 9007199254740991 {
			return SettingsTaskPage{}, fail("discovery_engine_response_invalid")
		}
	}
	out := SettingsTaskPage{Items: []SettingsTask{}}
	previous := int64(9007199254740992)
	for _, row := range rows {
		task, e := m.validateSettingsTask(object(row))
		if e != nil {
			return out, e
		}
		if task.ID >= previous {
			return out, fail("discovery_engine_response_invalid")
		}
		previous = task.ID
		if task.ID > after {
			out.Items = append(out.Items, task)
		}
	}
	out.Complete = len(rows) < limit || o["next"] == nil || previous <= after
	return out, nil
}

func (m *Meilisearch) Search(ctx context.Context, input SearchRequest, itemKeys []string, rankingMode string) (Object, error) {
	body := Object{"q": input.Query, "offset": input.After, "limit": input.Limit, "attributesToRetrieve": []string{"id", "kind", "sourceId", "version"}}
	filter := []string{}
	if input.Topic != "" {
		filter = append(filter, "topic = "+jsonString(input.Topic))
	}
	if itemKeys != nil {
		filter = append(filter, "id IN "+jsonString(itemKeys))
	}
	if len(filter) > 0 {
		body["filter"] = filter
	}
	if rankingMode == "newest" {
		body["sort"] = []string{"publishedAt:desc"}
	}
	v, e := m.call(ctx, "/indexes/"+m.index+"/search", http.MethodPost, body, false)
	if e != nil {
		return nil, e
	}
	return object(v), nil
}
