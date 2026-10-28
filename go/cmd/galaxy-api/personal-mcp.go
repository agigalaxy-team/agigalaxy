package main

import (
	"context"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/personalmcp"
)

// The root constructs each business service once and passes the same objects
// used by HTTP. Providers come from the identity-links load, never a second read.
func loadPersonalMCP(ctx context.Context, services personalmcp.Services, providers []accountlinks.LoginProvider) (*personalmcp.Handler, error) {
	return personalmcp.Load(ctx, os.Getenv("GALAXY_PERSONAL_MCP_CONFIG_FILE"), personalmcp.LoadOptions{Services: services, Providers: providers})
}
