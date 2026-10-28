package operationsstrategies

import (
	"context"
	"github.com/jackc/pgx/v5"
	"strings"
)

// QualifyOrdinaryExecutionWithin qualifies the existing selected strategy. It
// deliberately does not freeze the global head, which ordinary publication may
// replace in the same authorized execution.
func (s *Service) QualifyOrdinaryExecutionWithin(ctx context.Context, tx pgx.Tx, id string, actions []string) (bool, error) {
	head, e := s.head(ctx, tx)
	if e != nil {
		return false, e
	}
	version, e := s.version(ctx, tx, head["active_id"])
	if e != nil {
		return false, e
	}
	strategy := findStrategy(obj(version["configuration"]), id)
	if strategy == nil {
		return false, nil
	}
	if strategy["domain"] != "governance" || strategy["template"] != "selected-public-content-visibility" {
		return false, fail("operations_agentos_object_ineligible", 403)
	}
	ordinary := false
	for _, action := range actions {
		ordinary = ordinary || strings.HasPrefix(action, "strategies.ordinary.")
	}
	if ordinary && (strategy["ordinaryBounds"] == nil || strategy["mode"] == "human-led" || head["paused"] == true) {
		return false, fail("operations_agentos_object_ineligible", 403)
	}
	return true, nil
}
