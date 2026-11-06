package taskmaterials

import (
	"encoding/json"
	"github.com/google/uuid"
	"testing"
)

func TestEnrollmentWithoutDeadline(t *testing.T) {
	state := Object{"state": "open", "enrollment": Object{"state": "open"}, "request": Object{"enrollmentExpiresAt": nil}}
	if !enrollmentOpen(state, 100) {
		t.Fatal("undated request should remain open")
	}
	obj(state, "request")["enrollmentExpiresAt"] = int64(100)
	if enrollmentOpen(state, 100) {
		t.Fatal("dated request should expire at its deadline")
	}
	obj(state, "request")["enrollmentExpiresAt"] = int64(101)
	if !enrollmentOpen(state, 100) {
		t.Fatal("future deadline should remain open")
	}
	obj(state, "request")["enrollmentExpiresAt"] = nil
	obj(state, "enrollment")["state"] = "stopped"
	if enrollmentOpen(state, 100) {
		t.Fatal("author-stopped request must remain closed")
	}
}

func TestOptionalEnrollmentDeadlinePayloads(t *testing.T) {
	request := Object{"operationId": uuid.NewString(), "taskId": uuid.NewString(), "intent": "stuck", "workContext": Object{"goal": "A goal", "currentSituation": "A situation", "attemptRefs": []any{}}, "title": "A title", "summary": "A summary", "visibility": "Public", "collaboration": "open-assistance"}
	for _, test := range []struct {
		name    string
		present bool
		value   any
		valid   bool
	}{{"omitted", false, nil, true}, {"null", true, nil, true}, {"future", true, int64(2000000100), true}, {"invalid", true, "tomorrow", false}} {
		t.Run(test.name, func(t *testing.T) {
			delete(request, "enrollmentExpiresAt")
			if test.present {
				request["enrollmentExpiresAt"] = test.value
			}
			raw, _ := json.Marshal(request)
			got, e := parseTask(string(raw))
			if (e == nil) != test.valid {
				t.Fatalf("parse %s: %v", raw, e)
			}
			if e == nil && !test.present && got["enrollmentExpiresAt"] != nil {
				t.Fatal(got)
			}
		})
	}
	event := Object{"eventId": uuid.NewString(), "expectedTaskVersion": 1, "kind": "extend-enrollment", "enrollmentExpiresAt": nil}
	body := Object{"taskId": uuid.NewString(), "event": event}
	raw, _ := json.Marshal(body)
	if _, e := parseTaskEvent(string(raw)); e != nil {
		t.Fatal(e)
	}
	delete(event, "enrollmentExpiresAt")
	raw, _ = json.Marshal(body)
	if _, e := parseTaskEvent(string(raw)); e == nil {
		t.Fatal("missing deadline accepted")
	}
	event["enrollmentExpiresAt"] = "tomorrow"
	raw, _ = json.Marshal(body)
	if _, e := parseTaskEvent(string(raw)); e == nil {
		t.Fatal("invalid deadline accepted")
	}
}
