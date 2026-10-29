package agentos

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestConversationToolFailureProjection(t *testing.T) {
	for _, tc := range []struct {
		err         error
		code, class string
		status      int
		sql         string
	}{
		{fault.New("invalid_operations_agentos_request", 400), "invalid_operations_agentos_request", "fault", 400, ""},
		{errors.New("SECRET_CANARY"), "operations_agentos_tool_unavailable", "unexpected", 503, ""},
		{context.DeadlineExceeded, "operations_agentos_tool_request_timeout", "context-timeout", 503, ""},
		{&pgconn.PgError{Code: "23503", Message: "SECRET_CANARY", Detail: "SECRET_CANARY"}, "operations_agentos_tool_unavailable", "unexpected", 503, "23503"},
	} {
		out := conversationToolFailure(tc.err)
		if out["code"] != tc.code || out["failureClass"] != tc.class || out["httpStatus"] != tc.status || tc.sql != "" && out["sqlState"] != tc.sql {
			t.Fatalf("bad projection %#v", out)
		}
		b, _ := json.Marshal(out)
		if strings.Contains(string(b), "SECRET_CANARY") {
			t.Fatal("error prose leaked")
		}
	}
}
