package jobs

import "github.com/google/uuid"

func canonicalAutonomyID(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	parsed, err := uuid.Parse(text)
	return text, err == nil && parsed.String() == text
}

// validAutonomyPayload is shared by new River enqueue and legacy adoption.
func validAutonomyPayload(payload map[string]any, sourceID string) bool {
	if payload == nil {
		return false
	}
	for k := range payload {
		if k != "taskId" && k != "reconcile" && k != "nativeAttemptId" && k != "sessionId" {
			return false
		}
	}
	id, ok := canonicalAutonomyID(payload["taskId"])
	if !ok || id != sourceID {
		return false
	}
	if v, present := payload["reconcile"]; present {
		if _, ok := v.(bool); !ok {
			return false
		}
	}
	attempt, hasAttempt := payload["nativeAttemptId"]
	session, hasSession := payload["sessionId"]
	if hasAttempt != hasSession {
		return false
	}
	if hasAttempt {
		if _, ok := canonicalAutonomyID(attempt); !ok {
			return false
		}
		if _, ok := canonicalAutonomyID(session); !ok {
			return false
		}
	}
	return true
}
