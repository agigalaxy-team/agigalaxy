// Package discovery implements Galaxy's existing public-content qualification,
// durable outboxes and adapters to the configured professional discovery engines.
package discovery

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type Object = map[string]any
type Reference struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type Document struct {
	ID              string   `json:"id"`
	Kind            string   `json:"kind"`
	SourceID        string   `json:"sourceId"`
	Version         string   `json:"version"`
	IndexVersion    string   `json:"indexVersion"`
	PostID          string   `json:"postId"`
	AuthorAccountID *string  `json:"authorAccountId"`
	Title           string   `json:"title"`
	Body            string   `json:"body"`
	Topic           string   `json:"topic"`
	Tags            []string `json:"tags"`
	TagIDs          []string `json:"tagIds"`
	PublishedAt     int64    `json:"publishedAt"`
	PublishedUntil  int64    `json:"publishedUntil"`
}

func fail(code string) error { return fault.New(code, 503) }
func invalid() error         { return fault.New("invalid_discovery_request", 400) }
func validID(value string) bool {
	u, e := uuid.Parse(value)
	return e == nil && strings.EqualFold(u.String(), value) && (u == uuid.Nil || u == uuid.Max || u.Version() >= 1 && u.Version() <= 8 && u.Variant() == uuid.RFC4122)
}
func ItemKey(reference Reference) (string, error) {
	if (reference.Kind != "post" && reference.Kind != "reply") || !validID(reference.ID) {
		return "", invalid()
	}
	return reference.Kind + "_" + strings.ToLower(reference.ID), nil
}
func ItemReference(key string) *Reference {
	if len(key) < 6 {
		return nil
	}
	parts := strings.SplitN(key, "_", 2)
	if len(parts) != 2 || key != strings.ToLower(key) {
		return nil
	}
	r := Reference{Kind: parts[0], ID: parts[1]}
	if _, e := ItemKey(r); e != nil {
		return nil
	}
	return &r
}
func str(o Object, key string) string { v, _ := o[key].(string); return v }
func object(v any) Object             { o, _ := v.(map[string]any); return o }
func integer(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, e := n.Int64()
		return i, e == nil
	case float64:
		i := int64(n)
		return i, float64(i) == n
	case int:
		return int64(n), true
	case int64:
		return n, true
	}
	return 0, false
}
func decode(raw []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(target); e != nil {
		return e
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		return invalid()
	}
	return nil
}
func jsonString(value any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(value)
	return strings.TrimSuffix(b.String(), "\n")
}
func iso(seconds int64) string { return time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
