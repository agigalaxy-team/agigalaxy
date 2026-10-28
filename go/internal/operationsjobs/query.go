package operationsjobs

import (
	"context"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// QueryRead retains the typed reader's original attested authority facade.
// The actor is passed through unchanged and no public fields become proof.
func (s *Service) QueryRead(ctx context.Context, a Actor, authority p.Authority, queue string, filters Object) (Object, error) {
	if authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	after := ""
	limit := 20
	for k, v := range filters {
		switch k {
		case "after":
			value, ok := v.(string)
			if !ok || !uuidPattern.MatchString(value) {
				return nil, fail("operations_page_invalid", 400)
			}
			after = value
		case "limit":
			if !integer(v, 1) || number(v) > 100 {
				return nil, fail("operations_page_invalid", 400)
			}
			limit = int(number(v))
		default:
			return nil, fail("operations_page_invalid", 400)
		}
	}
	reader := *s
	reader.Authority = authority
	return reader.List(ctx, a, queue, after, limit)
}
