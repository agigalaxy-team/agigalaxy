package main

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/personalaudit"
	"github.com/jackc/pgx/v5/pgxpool"
)

func personalAuditService(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, governance community.GovernanceRuntime) (*personalaudit.Service, error) {
	s := &personalaudit.Service{Pool: pool, Endpoint: endpoint, Devices: devices}
	for key, output := range map[string]*[]string{"auditReaderIds": &s.ReaderIDs, "auditReviewerIds": &s.ReviewerIDs} {
		values, ok := governance.Configuration[key].([]any)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		for _, value := range values {
			id, ok := value.(string)
			if !ok {
				return nil, fault.New("governance_configuration_invalid", 400)
			}
			*output = append(*output, id)
		}
	}
	return s, nil
}
