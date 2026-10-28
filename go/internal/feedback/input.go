package feedback

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var modules = map[string]bool{"account": true, "community": true, "chat": true, "work": true, "discovery": true, "other": true}
var states = map[string]bool{"pending": true, "processing": true, "closed": true}

func invalid() error               { return fault.New("invalid_feedback_request", 400) }
func validCategory(s *string) bool { return s == nil || *s == "problem" || *s == "suggestion" }
func feedbackTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return r == 0xfeff || unicode.IsSpace(r) && r != 0x85 })
}
func text(s string, max int) (string, error) {
	s = feedbackTrim(s)
	if utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > max {
		return "", invalid()
	}
	for _, r := range s {
		if r < 32 && r != '\n' && r != '\t' && r != '\r' {
			return "", invalid()
		}
	}
	return s, nil
}
func prefix(s string, n int) string {
	// Match JavaScript String.slice's UTF-16 units for existing projections.
	u := utf16.Encode([]rune(s))
	if len(u) > n {
		u = u[:n]
	}
	return string(utf16.Decode(u))
}

type Reference struct {
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
}
type Submission struct {
	OperationID string      `json:"operationId"`
	Title       *string     `json:"title,omitempty"`
	Body        string      `json:"body"`
	Category    *string     `json:"category"`
	Module      string      `json:"module"`
	Attachments []Reference `json:"attachments,omitempty"`
}

func ParseSubmission(raw []byte) (x Submission, err error) {
	// Zod defaults apply to omitted values, never explicit null.
	var fields map[string]json.RawMessage
	if protocol.Decode(raw, &fields) != nil {
		return x, invalid()
	}
	for _, key := range []string{"operationId", "body", "title", "module", "attachments"} {
		if b, ok := fields[key]; ok && string(b) == "null" {
			return x, invalid()
		}
	}
	if protocol.Decode(raw, &x) != nil {
		return x, invalid()
	}
	if _, ok := fields["module"]; !ok {
		x.Module = "other"
	}
	if !uuidPattern.MatchString(x.OperationID) || !validCategory(x.Category) || !modules[x.Module] || len(x.Attachments) > 4 {
		return x, invalid()
	}
	if x.Body, err = text(x.Body, 6000); err != nil {
		return x, err
	}
	if x.Title != nil {
		v, e := text(*x.Title, 120)
		if e != nil {
			return x, e
		}
		x.Title = &v
	}
	seen := map[string]bool{}
	for _, r := range x.Attachments {
		if !uuidPattern.MatchString(r.ID) || !hashPattern.MatchString(r.SHA256) || seen[r.ID] {
			return x, invalid()
		}
		seen[r.ID] = true
	}
	return x, nil
}

type Update struct {
	OperationID      string          `json:"operationId"`
	ExpectedRevision int             `json:"expectedRevision"`
	Category         json.RawMessage `json:"category,omitempty"`
	Module           *string         `json:"module,omitempty"`
	State            *string         `json:"state,omitempty"`
	Note             *string         `json:"note,omitempty"`
}

func ParseUpdate(raw []byte) (x Update, err error) {
	if protocol.Decode(raw, &x) != nil || !uuidPattern.MatchString(x.OperationID) || x.ExpectedRevision < 1 || x.ExpectedRevision > 2147483646 {
		return x, invalid()
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if x.Module == nil && fields["module"] != nil || x.State == nil && fields["state"] != nil || x.Note == nil && fields["note"] != nil {
		return x, invalid()
	}
	if x.Module != nil && !modules[*x.Module] || x.State != nil && !states[*x.State] {
		return x, invalid()
	}
	if len(x.Category) > 0 {
		var c *string
		if json.Unmarshal(x.Category, &c) != nil || !validCategory(c) {
			return x, invalid()
		}
	}
	if x.Note != nil {
		v, e := text(*x.Note, 2000)
		if e != nil {
			return x, e
		}
		x.Note = &v
	}
	if len(x.Category) == 0 && x.Module == nil && x.State == nil && x.Note == nil {
		return x, invalid()
	}
	return x, nil
}
