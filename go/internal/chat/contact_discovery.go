package chat

import "github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"

// ContactDiscovery uses the same original opportunity context and current
// source reader as Recruitment; its temporary cursor key belongs to that service.
type ContactDiscovery = opportunities.Service

func stringValues(v any) []string {
	if values, ok := v.([]string); ok {
		return values
	}
	return uniqueStrings(v)
}
