package personalmcp

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/personalaudit"
)

// Each tool calls its original owning domain. The audit query has subject audit
// credentials; management audit permissions never substitute for that scope.
func (s Services) auditPackConsumers(out map[string]Consumer) {
	if p := s.Audit; p != nil {
		out["galaxy_audit_query"] = func(ctx context.Context, a deviceauth.Actor, q Object, id *string) (any, error) {
			return p.Query(ctx, personalaudit.Actor{Device: a, HTTPRequestID: id}, q, "query")
		}
	}
	if p := s.Builders; p != nil {
		rawWrite(out, "galaxy_worker_pack_use_record", p.PackUseSubmit)
		rawRead(out, "galaxy_worker_pack_candidates", p.PackUseCandidates)
		rawRead(out, "galaxy_worker_pack_use_receipt", p.PackUseReceipt)
		pointerRead(out, "galaxy_worker_pack_use_read", p.PackUseRead)
		pointerRead(out, "galaxy_worker_pack_uses", p.PackUseQuery)
	}
}
