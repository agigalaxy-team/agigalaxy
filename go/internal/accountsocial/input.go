package accountsocial

import (
	"encoding/json"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Reference struct {
	Kind      string `json:"kind"`
	PostID    string `json:"postId,omitempty"`
	CapsuleID string `json:"capsuleId,omitempty"`
	VersionID string `json:"versionId,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	SubjectID string `json:"subjectId,omitempty"`
	RoomID    string `json:"roomId,omitempty"`
	MessageID string `json:"messageId,omitempty"`
}

func (r Reference) Key() string {
	switch r.Kind {
	case "forum-post":
		return "forum-post:" + r.PostID
	case "capsule":
		return "capsule:" + r.CapsuleID + ":" + r.VersionID
	case "project":
		return "project:" + r.ProjectID
	case "person":
		return "person:" + r.SubjectID
	case "chat-message":
		return "chat-message:" + r.RoomID + ":" + r.MessageID
	}
	return ""
}
func (r Reference) Path() string {
	switch r.Kind {
	case "forum-post":
		return "/app/community/posts/" + r.PostID
	case "capsule":
		return "/app/capsules/" + r.CapsuleID + "/versions/" + r.VersionID
	case "project":
		return "/app/projects/" + r.ProjectID
	case "person":
		return "/app/people/" + r.SubjectID
	case "chat-message":
		return "/app/rooms/" + r.RoomID + "?message=" + r.MessageID
	}
	return ""
}
func reference(v any) (Reference, bool) {
	raw := encode(v)
	var r Reference
	if protocol.Decode(raw, &r) != nil {
		return r, false
	}
	keys := map[string][]string{"forum-post": {"postId"}, "capsule": {"capsuleId", "versionId"}, "project": {"projectId"}, "person": {"subjectId"}, "chat-message": {"roomId", "messageId"}}
	fields, ok := keys[r.Kind]
	if !ok {
		return r, false
	}
	p, e := shape(raw, append([]string{"kind"}, fields...), nil, "invalid_reading_bookmark_request")
	if e != nil {
		return r, false
	}
	for _, k := range fields {
		if r.Kind == "person" {
			if !subjectPattern.MatchString(str(p, k)) {
				return r, false
			}
		} else if !validID(str(p, k)) {
			return r, false
		}
	}
	return r, true
}

type followCommand struct {
	OperationID      string `json:"operationId"`
	TargetID         string `json:"targetAccountId"`
	Following        bool   `json:"following"`
	ExpectedRevision int64  `json:"expectedRevision"`
}
type bookmarkCommand struct {
	OperationID      string    `json:"operationId"`
	Reference        Reference `json:"reference"`
	Saved            bool      `json:"saved"`
	ExpectedRevision int64     `json:"expectedRevision"`
}

var afCursorPattern = regexp.MustCompile(`^af1\.[A-Za-z0-9_-]+$`)
var rbCursorPattern = regexp.MustCompile(`^rb2\.[A-Za-z0-9_-]+$`)

func parse(raw []byte, method string, follow, account bool) (Object, error) {
	code := "invalid_reading_bookmark_request"
	if follow {
		code = "invalid_account_follow_request"
	}
	required := []string{}
	optional := []string{}
	switch method {
	case "status":
		if follow {
			required = []string{"targetAccountId"}
		} else {
			required = []string{"reference"}
		}
	case "command":
		if follow {
			required = []string{"operationId", "targetAccountId", "following", "expectedRevision"}
		} else {
			required = []string{"operationId", "reference", "saved", "expectedRevision"}
		}
	case "receipt":
		required = []string{"operationId", "payloadHash"}
	case "query":
		optional = []string{"after", "limit"}
		if !follow {
			optional = append(optional, "kind")
			if account {
				optional = append(optional, "category")
			}
		}
	default:
		return nil, fault.New("not_found", 404)
	}
	p, e := shape(raw, required, optional, code)
	if e != nil {
		return nil, e
	}
	fail := func() (Object, error) { return nil, fault.New(code, 400) }
	if method == "command" || method == "receipt" {
		if !validID(str(p, "operationId")) {
			return fail()
		}
	}
	if method == "status" || method == "command" {
		if follow {
			if !validID(str(p, "targetAccountId")) {
				return fail()
			}
		} else {
			if _, ok := reference(p["reference"]); !ok {
				return fail()
			}
		}
	}
	if method == "command" {
		key := "saved"
		max := int64(2147483646)
		if follow {
			key = "following"
			max = 9007199254740991
		}
		if _, ok := p[key].(bool); !ok {
			return fail()
		}
		n, ok := number(p["expectedRevision"])
		if !ok || n > max {
			return fail()
		}
	}
	if method == "receipt" && !hashPattern.MatchString(str(p, "payloadHash")) {
		return fail()
	}
	if method == "query" {
		if v, ok := p["after"]; ok {
			s, ok := v.(string)
			if !ok {
				return fail()
			}
			valid := validID(s)
			if follow {
				valid = protocol.TextLength(s) <= 512 && afCursorPattern.MatchString(s)
			} else if account {
				valid = protocol.TextLength(s) <= 512 && rbCursorPattern.MatchString(s)
			}
			if !valid {
				return fail()
			}
		}
		max := int64(30)
		if follow {
			max = 50
		}
		if v, ok := p["limit"]; ok {
			n, valid := number(v)
			if !valid || n < 1 || n > max {
				return fail()
			}
		} else {
			p["limit"] = json.Number("20")
		}
		if v, ok := p["kind"]; ok {
			if !one(v, "forum-post", "capsule", "project", "person", "chat-message") {
				return fail()
			}
		}
		if v, ok := p["category"]; ok {
			if !one(v, "community", "private-chat") {
				return fail()
			}
		}
	}
	return p, nil
}
func one(v any, values ...string) bool {
	for _, s := range values {
		if v == s {
			return true
		}
	}
	return false
}
