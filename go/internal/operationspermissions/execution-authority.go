package operationspermissions

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ExecutionAuthority recognizes only a server-owned execution attestation.
// Public Actor fields and reconstructed JSON are never an execution identity.
type ExecutionAuthority interface {
	AcceptsExecution(Actor) bool
	RecheckExecutionWithin(context.Context, pgx.Tx, Actor, bool) (Actor, error)
	RequireExecutionAction(context.Context, pgx.Tx, Actor, string) (Actor, error)
	RequireExecutionOperation(context.Context, pgx.Tx, Actor, []string, Object) (Actor, error)
	GuardOperationWithin(context.Context, pgx.Tx, Actor, string, Object) error
	ExecutionMetadata(Actor) (Object, error)
}
