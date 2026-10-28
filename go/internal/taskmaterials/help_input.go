package taskmaterials

// ParseHelpPayload shares the actual Task/Participation parsers; Native keeps
// the supplied payload string unchanged for hashing, Consent and submission.
func ParseHelpPayload(kind, raw string) (Object, error) {
	switch kind {
	case "publish-task":
		return parseTask(raw)
	case "task-event":
		return parseTaskEvent(raw)
	case "participation-propose":
		return parseParticipation(raw, true)
	case "participation-event":
		return parseParticipation(raw, false)
	}
	return nil, fail("invalid_task_payload", 400)
}
