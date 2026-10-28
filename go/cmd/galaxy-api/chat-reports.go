package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/jackc/pgx/v5"
)

func chatReportService(gateway *access.Gateway, domain *businessadmin.Domain, rooms *chat.Service, files *chat.AttachmentService) *chat.ReportService {
	return &chat.ReportService{Chat: rooms, Attachments: files, Admin: domain,
		ReadPrincipalWithin: gateway.ReadOperationsPrincipalWithin,
		NamesWithin: func(ctx context.Context, tx pgx.Tx, ids []string) (map[string]string, error) {
			values, err := domain.NamesWithin(ctx, tx, ids)
			if err != nil {
				return nil, err
			}
			names := map[string]string{}
			for id, value := range values {
				if name, ok := value.(string); ok {
					names[id] = name
				}
			}
			return names, nil
		}}
}
