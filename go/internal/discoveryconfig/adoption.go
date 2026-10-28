package discoveryconfig

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
)

// The reference is captured only after these process instances were built.
// Metadata may supply a locator; it never supplies the adopted URL or secrets.
func ActualConnections(runtime *discovery.Runtime, configuration *discovery.Configuration, agent *agentos.Client, files *attachments.Configuration) systemsettings.ActualConnection {
	return func(_ context.Context, kind, id string) (systemsettings.Object, *bool, error) {
		binding := systemsettings.Object{"id": id, "kind": kind}
		configured := false
		switch kind {
		case "ai-execution":
			if agent == nil {
				return nil, nil, nil
			}
			observed := agent.ConnectionObservation()
			if observed.URL == "" {
				return nil, nil, nil
			}
			binding["url"] = observed.URL
			configured = observed.SigningConfigured && observed.ServiceConfigured
		case "file-scanning":
			if files == nil {
				return nil, nil, nil
			}
			scanner, ok := files.Scanner.(*attachments.ClamAV)
			if !ok || scanner == nil {
				return nil, nil, nil
			}
			timeout := scanner.Timeout
			if timeout <= 0 {
				timeout = time.Minute
			}
			binding["host"], binding["port"], binding["timeoutMs"] = scanner.Host, scanner.Port, timeout.Milliseconds()
			return binding, nil, nil
		case "search":
			if runtime == nil || runtime.Meili == nil || configuration == nil || configuration.Meilisearch == nil {
				return nil, nil, nil
			}
			cfg := configuration.Meilisearch
			index := "galaxy_public_community"
			if cfg.Index != nil && *cfg.Index != "" {
				index = *cfg.Index
			}
			binding["url"], binding["index"] = cfg.URL, index
			configured = systemsettings.ServiceCredentialsConfigured(kind, systemsettings.Object{"apiKey": cfg.APIKey})
		case "recommendation":
			if runtime == nil || runtime.Gorse == nil || configuration == nil || configuration.Gorse == nil {
				return nil, nil, nil
			}
			cfg := configuration.Gorse
			binding["url"] = cfg.URL
			configured = systemsettings.ServiceCredentialsConfigured(kind, systemsettings.Object{"apiKey": cfg.APIKey})
		case "analysis":
			if runtime == nil || runtime.OpenPanel == nil || configuration == nil || configuration.OpenPanel == nil {
				return nil, nil, nil
			}
			cfg := configuration.OpenPanel
			binding["url"], binding["projectId"], binding["clientId"], binding["readClientId"] = cfg.URL, cfg.ProjectID, cfg.ClientID, cfg.ReadClientID
			configured = systemsettings.ServiceCredentialsConfigured(kind, systemsettings.Object{"clientSecret": cfg.ClientSecret, "readClientSecret": cfg.ReadClientSecret})
		default:
			return nil, nil, nil
		}
		return binding, &configured, nil
	}
}
