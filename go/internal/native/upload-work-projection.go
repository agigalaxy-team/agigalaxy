package native

import (
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

var uploadTechnical = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:+-]*(?:/[a-zA-Z0-9][a-zA-Z0-9_.:+-]*)?$`)
var uploadDrive = regexp.MustCompile(`(?i)^[a-z]:/`)
var uploadSession = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,256}$`)

func uploadTechnicalID(value string) bool {
	return value != "" && protocol.TextLength(value) <= 128 && uploadTechnical.MatchString(value) && !uploadDrive.MatchString(value)
}
func uploadRows(value any) []any {
	if values, ok := value.([]any); ok {
		return values
	}
	return []any{}
}
func uploadEnvironmentVersions(value any) any {
	environment := uploadObject(value)
	facts := uploadObject(environment["facts"])
	safe := map[string]any{}
	for _, key := range []string{"host", "hostVersion", "platform", "architecture", "runtime", "runtimeVersion", "selectedModel", "actualModel"} {
		value := text(facts[key])
		if uploadTechnicalID(value) {
			safe[key] = value
		}
	}
	if tools, ok := facts["tools"].([]any); ok {
		kept := []any{}
		for _, value := range tools {
			s := text(value)
			if uploadTechnicalID(s) && !regexp.MustCompile(`/`).MatchString(s) && len(kept) < 256 {
				kept = append(kept, s)
			}
		}
		safe["tools"] = kept
	}
	result := map[string]any{"facts": safe}
	for _, key := range []string{"id", "version", "observedAt"} {
		if value, ok := environment[key]; ok {
			result[key] = value
		}
	}
	return result
}

// ProjectWorkForUpload is the existing four-level field projection. It does not
// authorize a target, enlarge a source selection, submit a body or run a model.
func ProjectWorkForUpload(settings UploadPrivacySettings, record map[string]any) (map[string]any, error) {
	settings = NormalizeUploadPrivacy(settings)
	work, ok := record["work"].(map[string]any)
	if !ok {
		return nil, connectionFailure("local_work_upload_source_required")
	}
	if settings.Level == "local-only" {
		return map[string]any{"data": nil, "omittedDataTypes": []string{"history-metadata", "environment-versions", "work-summary", "work-content"}, "uploadStarted": false}, nil
	}
	host := text(work["host"])
	if !isOne(host, "opencode", "codex", "claude-code", "claude", "gemini-cli", "cursor", "vscode", "windsurf", "openclaw", "mcp", "host", "unknown") {
		host = "unknown"
	}
	source := map[string]any{"host": host}
	if uploadSession.MatchString(text(work["sessionId"])) {
		source["sessionId"] = work["sessionId"]
	}
	workType, role, outcome := text(work["workType"]), text(work["role"]), text(work["outcome"])
	if !isOne(workType, "unknown", "development", "research", "writing", "design", "operations", "analysis", "learning", "other") {
		workType = "unknown"
	}
	if !isOne(role, "unknown", "owner", "participant", "contributor", "reviewer", "observer") {
		role = "unknown"
	}
	if !isOne(outcome, "unknown", "reported-success", "reported-failure", "partial", "cancelled") {
		outcome = "unknown"
	}
	resultSource := "host-observations"
	if work["sourceKind"] == "user-model" {
		resultSource = "user-model"
	}
	data := map[string]any{"source": source, "uploadLevel": settings.Level, "workType": workType, "role": role, "resultStatus": outcome, "resultSource": resultSource}
	for _, key := range []string{"workId", "galaxyId", "startedAt", "updatedAt"} {
		if value, ok := work[key]; ok {
			data[key] = value
		}
	}
	omitted := []string{}
	if isOne(settings.Level, "work-content", "conversation-archive") {
		summary := map[string]any{"title": text(work["title"]), "summary": text(work["summary"]), "sourceKind": "host-observations"}
		if text(work["summary"]) != "" && work["sourceKind"] == "user-model" {
			summary["sourceKind"] = "user-model"
		}
		for _, key := range []string{"outcome", "summaryRevision", "updatedAt"} {
			if value, ok := work[key]; ok {
				summary[key] = value
			}
		}
		data["summary"] = summary
	} else if text(work["summary"]) != "" || text(work["title"]) != "" {
		omitted = append(omitted, "work-summary")
	}
	environments := []any{}
	for _, value := range uploadRows(record["environments"]) {
		environments = append(environments, uploadEnvironmentVersions(value))
	}
	data["environments"] = environments
	if isOne(settings.Level, "work-content", "conversation-archive") {
		data["observations"] = uploadRows(record["observations"])
	} else if len(uploadRows(record["observations"])) > 0 {
		omitted = append(omitted, "work-content")
	}
	if e := connectionNoCredentials(data); e != nil {
		return nil, e
	}
	return map[string]any{"data": data, "omittedDataTypes": omitted, "uploadStarted": false}, nil
}
func boundWorkProjection(data map[string]any) (map[string]any, error) {
	detailed := data["uploadLevel"] != "history-overview"
	all := uploadRows(data["observations"])
	omitted := []string{}
	if len(uploadRows(data["environments"])) > 1000 {
		data["environments"] = []any{}
		omitted = append(omitted, "environments")
	}
	if detailed {
		rows := all
		if len(rows) > 2000 {
			rows = rows[len(rows)-2000:]
		}
		data["observations"] = rows
	}
	refresh := func() (int, error) {
		if detailed {
			rows := uploadRows(data["observations"])
			var first, last any
			if len(rows) > 0 {
				first = uploadObject(rows[0])["sequence"]
				last = uploadObject(rows[len(rows)-1])["sequence"]
			}
			coverage := map[string]any{"observations": map[string]any{"sourceTotal": len(all), "included": len(rows), "firstSequence": first, "lastSequence": last, "hasEarlier": len(rows) < len(all)}}
			if len(omitted) > 0 {
				coverage["omittedFields"] = omitted
			}
			data["coverage"] = coverage
		}
		raw, e := localdata.Encode(data)
		return len(raw), e
	}
	size, e := refresh()
	if e != nil {
		return nil, e
	}
	if size > 524288 && data["summary"] != nil {
		delete(data, "summary")
		omitted = append(omitted, "summary")
	}
	size, e = refresh()
	if e != nil {
		return nil, e
	}
	if size > 524288 && len(uploadRows(data["environments"])) > 0 {
		data["environments"] = []any{}
		if !connectionIncludes(omitted, "environments") {
			omitted = append(omitted, "environments")
		}
	}
	size, e = refresh()
	if e != nil {
		return nil, e
	}
	if detailed && size > 524288 {
		candidates := uploadRows(data["observations"])
		low, high := 0, len(candidates)
		for low < high {
			count := (low + high + 1) / 2
			data["observations"] = candidates[len(candidates)-count:]
			size, e = refresh()
			if e != nil {
				return nil, e
			}
			if size <= 524288 {
				low = count
			} else {
				high = count - 1
			}
		}
		data["observations"] = candidates[len(candidates)-low:]
		if _, e = refresh(); e != nil {
			return nil, e
		}
	}
	return data, nil
}
