package native

import (
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var continuationFragment = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func continuationPath(object map[string]any) string {
	kind := text(object["kind"])
	if kind == "context" {
		return ""
	}
	route := map[string]string{"task": "tasks", "room": "rooms", "project": "projects", "person": "people", "post": "community/posts", "capsule": "capsules"}[kind]
	if route == "" {
		return ""
	}
	path := "/app/" + route + "/" + text(object["id"])
	if id := text(object["versionId"]); id != "" {
		path += "/versions/" + id
	}
	return path
}
func continuationOrigin(value string) bool {
	u, e := whatwg.Parse(value)
	return e == nil && u.Scheme() == "https" && u.Username() == "" && u.Password() == "" && "https://"+u.Host() == value
}
func continuationReturnPath(value string) bool {
	if len(value) < 5 || !strings.HasPrefix(value, "/app") || strings.Contains(value, `\`) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || r >= 0x202a && r <= 0x202e || r >= 0x2066 && r <= 0x2069 {
			return false
		}
	}
	u, e := whatwg.Parse("https://galaxy.invalid" + value)
	if e != nil || "https://"+u.Host() != "https://galaxy.invalid" || u.Pathname() != "/app" && !strings.HasPrefix(u.Pathname(), "/app/") || u.Pathname()+u.Search()+u.Hash() != value {
		return false
	}
	for _, item := range strings.Split(strings.TrimPrefix(u.Search(), "?"), "&") {
		name := strings.SplitN(item, "=", 2)[0]
		key, _ := url.QueryUnescape(name)
		if key == "agentConnect" || key == "agentBridgeOrigin" {
			return false
		}
	}
	return true
}
func readContinuationLink(link string) (map[string]any, error) {
	bad := func() (map[string]any, error) { return nil, connectionFailure("work_continuation_link_invalid") }
	u, e := whatwg.Parse(link)
	if e != nil || u.Scheme() != "https" || u.Username() != "" || u.Password() != "" || u.Search() != "" || !strings.HasPrefix(u.Hash(), "#galaxy-work=") {
		return bad()
	}
	encoded := strings.TrimPrefix(u.Hash(), "#galaxy-work=")
	// The original JavaScript bound is 1..14000 UTF-16 units. Every allowed
	// character is ASCII, so its byte count is exactly the same length.
	if len(encoded) < 1 || len(encoded) > 14000 || !continuationFragment.MatchString(encoded) {
		return bad()
	}
	raw, e := base64.RawURLEncoding.DecodeString(encoded)
	if e != nil || !utf8.Valid(raw) {
		return bad()
	}
	v, e := jstext.DecodeJSON(raw)
	request := uploadObject(v)
	if e != nil || request == nil {
		return bad()
	}
	switch purpose := request["purpose"].(type) {
	case string:
		request["purpose"] = uploadTrim(purpose)
	case jstext.String:
		request["purpose"] = purpose.Trim()
	}
	schema := uploadObject(workPurposeContracts()["continuationRequest"])
	remoteDefaults(schema, request)
	if remoteChatValidate(schema, request) != nil || !continuationOrigin(text(request["endpoint"])) || !continuationReturnPath(text(request["returnTo"])) || continuationPath(uploadObject(request["object"])) != u.Pathname() {
		return bad()
	}
	website := "https://" + u.Host()
	request["website"] = website
	request["sourceUrl"] = website + u.Pathname()
	request["returnUrl"] = website + text(request["returnTo"])
	return request, nil
}
