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
)

func run(ctx context.Context, args []string) error {
	if len(args) < 1 {
		return fault.New("native_command_required", 400)
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
	case "native":
		s, e := native.NewToolServer(store)
		if e != nil {
			return e
		}
		return s.Run(ctx, &mcp.StdioTransport{})
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
