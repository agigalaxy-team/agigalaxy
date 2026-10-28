package main

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
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
	case "host":
		return native.ServeHost(ctx, store, os.Stdin, os.Stdout)
	case "native":
		runtime, e := native.NewRuntime(store, c, native.ConnectionOptions{})
		if e != nil {
			return e
		}
		defer runtime.Close()
		var artifacts []*native.InteractionArtifact
		executable, e := os.Executable()
		if e != nil {
			return e
		}
		artifactDirectory := filepath.Join(filepath.Dir(executable), "dist")
		if _, e = os.Stat(artifactDirectory); e == nil {
			artifact, e := native.LoadInteractionArtifact(artifactDirectory)
			if e != nil {
				return e
			}
			artifacts = append(artifacts, artifact)
		} else if !os.IsNotExist(e) {
			return e
		}
		s, e := native.NewRuntimeToolServer(store, runtime, artifacts...)
		if e != nil {
			return e
		}
		runtime.ResumePrivateSync(0)
		return s.Run(ctx, native.HostSessionTransport(runtime, &mcp.StdioTransport{}))
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if e := run(ctx, os.Args[1:]); e != nil {
		slog.Error("galaxy command failed", "code", fault.Code(e))
		os.Exit(1)
	}
}
