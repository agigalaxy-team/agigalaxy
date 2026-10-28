// Package failureaudit persists only the original bounded HTTP failure context.
package failureaudit

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type Authentication struct {
	Version          int      `json:"version"`
	ClientID         string   `json:"clientId"`
	Audience         string   `json:"audience"`
	Scope            string   `json:"scope"`
	BindingScopes    []string `json:"bindingScopes"`
	CredentialScopes []string `json:"credentialScopes"`
	Profile          string   `json:"profile,omitempty"`
	Endpoint         string   `json:"endpoint,omitempty"`
}
type Actor struct {
	SubjectID      string          `json:"subjectId"`
	BindingID      string          `json:"bindingId"`
	Authentication *Authentication `json:"authentication,omitempty"`
}
type Event struct {
	RequestID  string `json:"requestId"`
	Status     int    `json:"status"`
	Route      string `json:"route"`
	Actor      *Actor `json:"actor"`
	ObservedAt string `json:"observedAt"`
}
type Result struct {
	State string `json:"state"`
}

var eventRoute = regexp.MustCompile(`^(http\.(request|parser)|(?:GET|POST) /[a-z0-9/.:_-]+)$`)
var eventUUID = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var scopePattern = regexp.MustCompile(`^[a-z][a-z-]{0,63}$`)
var datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$`)

func safeError(code string) error { return fault.New(code, 500) }
func validURL(s string) bool      { u, e := url.Parse(s); return e == nil && u.IsAbs() && u.Scheme != "" }
func validScopes(values []string) bool {
	if len(values) < 1 || len(values) > 64 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range values {
		if !scopePattern.MatchString(v) || seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}
func normalize(event Event, now time.Time) (Event, error) {
	if event.ObservedAt == "" {
		event.ObservedAt = now.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if !eventUUID.MatchString(event.RequestID) || event.Status < 400 || event.Status > 599 || len(event.Route) > 100 || !eventRoute.MatchString(event.Route) || !datePattern.MatchString(event.ObservedAt) {
		return Event{}, safeError("failure_audit_event_invalid")
	}
	if _, e := time.Parse(time.RFC3339Nano, event.ObservedAt); e != nil {
		return Event{}, safeError("failure_audit_event_invalid")
	}
	if event.Actor == nil {
		return event, nil
	}
	a := *event.Actor
	event.Actor = &a
	if !subjectPattern.MatchString(a.SubjectID) || !eventUUID.MatchString(a.BindingID) {
		return Event{}, safeError("failure_audit_actor_invalid")
	}
	if a.Authentication == nil {
		return event, nil
	}
	auth := *a.Authentication
	a.Authentication = &auth
	auth.BindingScopes = append([]string(nil), auth.BindingScopes...)
	auth.CredentialScopes = append([]string(nil), auth.CredentialScopes...)
	if !validURL(auth.Audience) || !scopePattern.MatchString(auth.Scope) || !validScopes(auth.BindingScopes) || !validScopes(auth.CredentialScopes) {
		return Event{}, safeError("failure_audit_actor_invalid")
	}
	found := false
	for _, v := range auth.CredentialScopes {
		found = found || v == auth.Scope
	}
	if !found {
		return Event{}, safeError("failure_audit_actor_invalid")
	}
	if auth.Version == 1 {
		if !eventUUID.MatchString(auth.ClientID) || auth.Profile != "" || auth.Endpoint != "" {
			return Event{}, safeError("failure_audit_actor_invalid")
		}
	} else if auth.Version == 2 {
		if auth.Profile != "oauth-resource" || !validURL(auth.Endpoint) || auth.Audience != auth.Endpoint+"/mcp/personal" || len([]rune(auth.ClientID)) < 1 || len([]rune(auth.ClientID)) > 200 {
			return Event{}, safeError("failure_audit_actor_invalid")
		}
		for _, r := range auth.ClientID {
			if unicode.IsControl(r) {
				return Event{}, safeError("failure_audit_actor_invalid")
			}
		}
	} else {
		return Event{}, safeError("failure_audit_actor_invalid")
	}
	return event, nil
}
func encode(value any) string {
	var out bytes.Buffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	_ = e.Encode(value)
	return strings.TrimSuffix(out.String(), "\n")
}
func decodeEvent(raw string) (Event, error) {
	// Strict JS schemas distinguish an omitted actor from explicit null, and
	// reject authentication:null or v1 snapshots carrying v2-only fields.
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &fields) != nil || fields["actor"] == nil {
		return Event{}, safeError("failure_audit_event_invalid")
	}
	if string(fields["actor"]) != "null" {
		var actor map[string]json.RawMessage
		if json.Unmarshal(fields["actor"], &actor) != nil {
			return Event{}, safeError("failure_audit_event_invalid")
		}
		if auth, ok := actor["authentication"]; ok {
			var snapshot map[string]json.RawMessage
			if string(auth) == "null" || json.Unmarshal(auth, &snapshot) != nil {
				return Event{}, safeError("failure_audit_actor_invalid")
			}
			var version int
			_ = json.Unmarshal(snapshot["version"], &version)
			if version == 1 && (snapshot["profile"] != nil || snapshot["endpoint"] != nil) {
				return Event{}, safeError("failure_audit_actor_invalid")
			}
		}
	}
	var event Event
	d := json.NewDecoder(strings.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&event); e != nil {
		return event, safeError("failure_audit_event_invalid")
	}
	if d.Decode(new(any)) != io.EOF || event.ObservedAt == "" {
		return event, safeError("failure_audit_event_invalid")
	}
	return normalize(event, time.Time{})
}
