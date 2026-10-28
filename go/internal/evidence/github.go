package evidence

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	"regexp"
	"strings"
	"time"
)

// Source is a configured code adapter, not an issuer supplied by request data.
// Verify performs I/O; CheckObservation verifies its exact reported reference.
type Source interface {
	JobKind() string
	Verifier() string
	Reference(any) (Object, error)
	SourceKey(Object) string
	Verify(context.Context, Object, int64) (Object, error)
	CheckObservation(Object, Object, int64) (Object, error)
}
type GithubSource struct {
	Fetch func(context.Context, string, int, time.Duration) ([]byte, error)
}

func (GithubSource) JobKind() string  { return "verify-github" }
func (GithubSource) Verifier() string { return "github-actions-api/0.1" }

var ownerPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$`)
var repoPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$`)
var commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

func (GithubSource) Reference(v any) (Object, error) {
	o := obj(v)
	if !exact(o, []string{"provider", "owner", "repository", "runId", "attempt", "commit"}, nil) || o["provider"] != "github-actions" || !ownerPattern.MatchString(str(o, "owner")) || !repoPattern.MatchString(str(o, "repository")) || !safe(o, "runId", 1, 9007199254740991) || !safe(o, "attempt", 1, 10000) || !commitPattern.MatchString(str(o, "commit")) {
		return nil, fault.New("invalid_evidence", 400)
	}
	return o, nil
}
func (GithubSource) SourceKey(r Object) string {
	return fmt.Sprintf("github-actions:%s/%s:%d:%d:%s", strings.ToLower(str(r, "owner")), strings.ToLower(str(r, "repository")), num(r, "runId"), num(r, "attempt"), str(r, "commit"))
}
func (s GithubSource) Verify(ctx context.Context, r Object, now int64) (Object, error) {
	if s.Fetch == nil {
		s.Fetch = publicfetch.Get
	}
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/runs/%d/attempts/%d", str(r, "owner"), str(r, "repository"), num(r, "runId"), num(r, "attempt"))
	raw, e := s.Fetch(ctx, url, 131072, 5*time.Second)
	if e != nil {
		return nil, e
	}
	run, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	return InspectGithubRun(r, run, now)
}
func control(v any) bool {
	o := obj(v)
	if !exact(o, []string{"version", "observedVia", "repositoryOwner", "submitterControlVerified", "independentExecutionVerified"}, nil) || !safe(o, "version", 1, 1) || o["observedVia"] != "github-rest-api" || o["submitterControlVerified"] != false || o["independentExecutionVerified"] != false {
		return false
	}
	if o["repositoryOwner"] == nil {
		return true
	}
	owner := obj(o["repositoryOwner"])
	return exact(owner, []string{"id", "login", "type"}, nil) && safe(owner, "id", 1, 9007199254740991) && protocol.TextLength(str(owner, "login")) >= 1 && protocol.TextLength(str(owner, "login")) <= 100 && one(owner["type"], "User", "Organization", "Bot")
}
func conclusion(v any) bool {
	return v == nil || one(v, "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure")
}
func InspectGithubRun(reference Object, raw any, now int64) (Object, error) {
	s := GithubSource{}
	r, e := s.Reference(reference)
	if e != nil {
		return nil, e
	}
	run := obj(raw)
	repo := obj(run["repository"])
	updated := str(run, "updated_at")
	stamp, e := time.Parse(time.RFC3339Nano, updated)
	if !safe(run, "id", 1, 9007199254740991) || !safe(run, "run_attempt", 1, 10000) || num(run, "id") != num(r, "runId") || num(run, "run_attempt") != num(r, "attempt") || run["head_sha"] != r["commit"] || !strings.EqualFold(str(repo, "full_name"), str(r, "owner")+"/"+str(r, "repository")) || repo["private"] != false || !safe(repo, "id", -9007199254740991, 9007199254740991) || e != nil || stamp.Unix() > now+300 {
		return nil, fmt.Errorf("source reference mismatch")
	}
	var outcome any
	if c, ok := run["conclusion"].(string); ok {
		outcome = c
	}
	if !one(run["status"], "completed", "queued", "in_progress", "waiting", "pending", "requested") || !conclusion(outcome) {
		return nil, fmt.Errorf("unsupported source outcome")
	}
	var owner any
	if v, ok := repo["owner"]; ok {
		p := obj(v)
		owner = ordered("id", p["id"], "login", p["login"], "type", p["type"])
	}
	sourceControl := ordered("version", 1, "observedVia", "github-rest-api", "repositoryOwner", owner, "submitterControlVerified", false, "independentExecutionVerified", false)
	if !control(sourceControl) || owner != nil && !strings.EqualFold(str(obj(owner), "login"), str(r, "owner")) {
		return nil, fmt.Errorf("source owner metadata mismatch")
	}
	source := ordered("provider", r["provider"], "owner", r["owner"], "repository", r["repository"], "runId", r["runId"], "attempt", r["attempt"], "commit", r["commit"], "repositoryId", repo["id"], "sourceUpdatedAt", updated)
	wire, e := protocol.EncodeJS(raw)
	if e != nil {
		return nil, e
	}
	return Object{"status": "observed", "strength": "ci-execution-fact", "independence": "repository-controlled", "sourceControl": sourceControl, "attribution": "submitter-asserted", "capabilitiesVerified": false, "completed": run["status"] == "completed", "conclusion": outcome, "source": source, "collectedAt": now, "validUntil": now + 3600, "verifier": s.Verifier(), "responseHash": identity.Digest(wire), "limitations": []any{"Repository workflows may be controlled by the submitter.", "A CI conclusion does not prove task quality or individual contribution."}}, nil
}
func (s GithubSource) CheckObservation(o, reference Object, now int64) (Object, error) {
	invalid := func() (Object, error) { return nil, fmt.Errorf("invalid evidence observation") }
	if !exact(o, []string{"status", "strength", "independence", "attribution", "capabilitiesVerified", "completed", "conclusion", "source", "collectedAt", "validUntil", "verifier", "responseHash", "limitations"}, []string{"sourceControl"}) || o["status"] != "observed" || o["strength"] != "ci-execution-fact" || o["independence"] != "repository-controlled" || o["attribution"] != "submitter-asserted" || o["capabilitiesVerified"] != false || o["verifier"] != s.Verifier() || !conclusion(o["conclusion"]) || !safe(o, "collectedAt", -9007199254740991, 9007199254740991) || !safe(o, "validUntil", -9007199254740991, 9007199254740991) || !hashPattern.MatchString(str(o, "responseHash")) {
		return invalid()
	}
	if _, ok := o["completed"].(bool); !ok {
		return invalid()
	}
	source := obj(o["source"])
	if !exact(source, []string{"provider", "owner", "repository", "runId", "attempt", "commit", "repositoryId", "sourceUpdatedAt"}, nil) || !safe(source, "repositoryId", 1, 9007199254740991) {
		return invalid()
	}
	r := Object{}
	for _, k := range []string{"provider", "owner", "repository", "runId", "attempt", "commit"} {
		r[k] = source[k]
	}
	if _, e := s.Reference(r); e != nil {
		return invalid()
	}
	if s.SourceKey(r) != s.SourceKey(reference) {
		return invalid()
	}
	stamp, e := time.Parse(time.RFC3339Nano, str(source, "sourceUpdatedAt"))
	if e != nil || stamp.Format(time.RFC3339Nano) == "" || !strings.HasSuffix(str(source, "sourceUpdatedAt"), "Z") {
		return invalid()
	}
	limitations, ok := o["limitations"].([]any)
	if !ok || len(limitations) == 0 {
		return invalid()
	}
	for _, v := range limitations {
		if s, ok := v.(string); !ok || protocol.TextLength(s) < 1 {
			return invalid()
		}
	}
	if v, ok := o["sourceControl"]; ok {
		if !control(v) {
			return invalid()
		}
		if owner := obj(obj(v)["repositoryOwner"]); owner != nil && !strings.EqualFold(str(owner, "login"), str(reference, "owner")) {
			return invalid()
		}
	}
	if num(o, "collectedAt") != now || num(o, "validUntil") <= now || num(o, "validUntil") > now+3600 {
		return invalid()
	}
	return o, nil
}
