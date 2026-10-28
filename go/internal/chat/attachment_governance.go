package chat

import "github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"

func (f *AttachmentService) GovernanceAdapter() *filegovernance.FileAdapter {
	return &filegovernance.FileAdapter{Store: f.Store, Policy: f.policy(), Available: func() bool { return f.configured() == nil }, AuthorPending: f.authorPending}
}
