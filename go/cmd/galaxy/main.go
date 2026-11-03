package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

func run(ctx context.Context, args []string) error {
	if len(args) < 1 {
		return localCommand(ctx, "status", nil)
	}
	switch args[0] {
	case "help", "--help", "-h":
		usage()
		return nil
	case "init", "status", "export", "integration-mcp", "integration-host":
		return localCommand(ctx, args[0], args[1:])
	case "service-config":
		return serviceConfigurationCommand(ctx, args[1:])
	case "command":
		return menuCommand(ctx, args[1:])
	case "host-configs":
		return hostConfigurationsCommand(ctx, args[1:])
	case "setup":
		return setupCommand(ctx, args[1:])
	case "install", "update", "repair", "uninstall":
		return managedClientCommand(ctx, args[0], args[1:])
	case "ingress":
		return hostIngressCommand(ctx, args[1:])
	case "service":
		return nativeServiceCommand(ctx, args[1:])
	case "native-service":
		return nativebridge.Run(ctx)
	}
	configPath := os.Getenv("GALAXY_NATIVE_CONFIG")
	for i := 1; i < len(args); i++ {
		if args[i] != "--config" || i+1 == len(args) {
			return fault.New("native_arguments_invalid", 400)
		}
		i++
		configPath = args[i]
	}
	c, e := native.ReadConfiguration(configPath)
	if e != nil {
		return e
	}
	store, e := native.NewStore(c.DataDirectory, c.Endpoint)
	if e != nil {
		return e
	}
	switch args[0] {
	case "host", "native":
		channel := nativebridge.MCP
		if args[0] == "host" {
			channel = nativebridge.Host
		}
		return relayNative(ctx, nativebridge.Profile{ConfigurationPath: configPath}, channel)
	case "identity":
		v, e := store.Identity(ctx)
		if e != nil {
			return e
		}
		b, e := protocol.Encode(map[string]any{"identity": v, "localOnly": true})
		if e != nil {
			return e
		}
		_, e = fmt.Fprintln(os.Stdout, string(b))
		return e
	default:
		return fault.New("native_command_unknown", 400)
	}
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx, os.Args[1:]); e != nil {
		if errors.Is(e, nativebridge.ErrPaused) {
			slog.Info("galaxy service stopped", "code", "native_service_paused")
			os.Exit(75)
		}
		slog.Error("galaxy command failed", "code", fault.Code(e))
		os.Exit(1)
	}
}
