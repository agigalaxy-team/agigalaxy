package operationsautonomy

import "github.com/agigalaxy-team/agigalaxy/go/internal/fault"

// PreparationRejection proves only that this invocation did not reach duty
// dispatch. It does not resolve another concurrent invocation of the same ID.
type PreparationRejection struct {
	phase string
	cause error
}

func (e *PreparationRejection) Error() string { return fault.Code(e.cause) }
func (e *PreparationRejection) Unwrap() error { return e.cause }
func (e *PreparationRejection) Phase() string { return e.phase }

// MarkPreparationRejected is restricted to the three pre-dispatch stages.
func MarkPreparationRejected(phase string, cause error) error {
	if cause == nil {
		return nil
	}
	switch phase {
	case "prepare", "bind", "qualify":
		return &PreparationRejection{phase: phase, cause: cause}
	default:
		return cause
	}
}
