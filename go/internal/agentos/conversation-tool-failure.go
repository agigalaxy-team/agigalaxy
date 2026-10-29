package agentos

import (
	"context"
	"errors"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgconn"
)

var toolSQLState = regexp.MustCompile(`^[0-9A-Z]{5}$`)

// Only closed error classification enters the ledger. Never persist error
// prose, database detail, request/configuration, stack traces, or URLs.
func conversationToolFailure(err error) Object {
	code := fault.Code(err)
	if code != "invalid_operations_agentos_query" && code != "invalid_operations_agentos_request" && !(code == "invalid_p13_strategy_request" && (fault.Status(err) == 400 || fault.Status(err) == 422)) && !toolSafeError.MatchString(code) {
		code = "operations_agentos_tool_unavailable"
	}
	class := "unexpected"
	var f *fault.Error
	switch {
	case errors.Is(err, context.Canceled):
		code, class = "operations_agentos_tool_request_cancelled", "context-cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		code, class = "operations_agentos_tool_request_timeout", "context-timeout"
	case errors.As(err, &f):
		class = "fault"
	}
	out := Object{"code": code, "failureClass": class}
	if status := fault.Status(err); status >= 400 && status <= 599 {
		out["httpStatus"] = status
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && toolSQLState.MatchString(pg.Code) {
		out["sqlState"] = pg.Code
	}
	return out
}
