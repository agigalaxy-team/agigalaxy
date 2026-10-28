package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func printValue(value any) error {
	raw, e := protocol.Encode(value)
	if e != nil {
		return e
	}
	_, e = fmt.Fprintln(os.Stdout, string(raw))
	return e
}
func arguments(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}
func localCommand(ctx context.Context, name string, args []string) error {
	flags := arguments(name)
	directory := flags.String("data-dir", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	selected := *directory
	if selected == "" {
		selected = os.Getenv("GALAXY_DATA_DIR")
	}
	if selected == "" {
		home, e := os.UserHomeDir()
		if e != nil {
			return e
		}
		selected = filepath.Join(home, ".galaxy")
	}
	absolute, e := filepath.Abs(selected)
	if e != nil {
		return e
	}
	store, e := native.NewStore(absolute, "")
	if e != nil {
		return e
	}
	var value any
	switch name {
	case "integration-host":
		return native.ServeHost(ctx, store, os.Stdin, os.Stdout)
	case "integration-mcp":
		server, err := native.NewToolServer(store)
		if err != nil {
			return err
		}
		return server.Run(ctx, &mcp.StdioTransport{})
	case "status":
		value, e = store.LocalStatus(ctx)
	case "export":
		value, e = store.ExportLocalData(ctx)
	case "init":
		// The explicit local init command is the existing creation choice.
		// MCP tools separately require the person's original review protocol.
		var scope native.ChoiceScope
		scope, e = store.ChoiceScope(ctx)
		if e == nil {
			value, e = store.InitializeLocalIdentity(ctx, "", true, &scope)
		}
	default:
		return fault.New("native_command_unknown", 400)
	}
	if e != nil {
		return e
	}
	return printValue(value)
}
func serviceConfigurationCommand(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] != "inspect" && args[0] != "prepare" {
		return fault.New("native_arguments_invalid", 400)
	}
	flags := arguments("service-config")
	request := native.ServiceConfigurationRequest{}
	flags.StringVar(&request.Website, "website", "", "")
	flags.StringVar(&request.Endpoint, "endpoint", "", "")
	flags.StringVar(&request.DataDirectory, "data-dir", "", "")
	flags.StringVar(&request.Output, "output", "", "")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	var value any
	var e error
	if args[0] == "inspect" {
		if request.DataDirectory != "" || request.Output != "" {
			return fault.New("native_arguments_invalid", 400)
		}
		value, e = native.InspectServiceConfiguration(ctx, request, native.ServiceConfigurationOptions{})
	} else {
		value, e = native.PrepareServiceConfiguration(ctx, request, native.ServiceConfigurationOptions{})
	}
	if e != nil {
		return e
	}
	return printValue(value)
}
func menuCommand(ctx context.Context, args []string) error {
	flags := arguments("command")
	configuration := flags.String("config", os.Getenv("GALAXY_NATIVE_CONFIG"), "")
	name := flags.String("command", "open", "")
	language := flags.String("language", "", "")
	stage := flags.String("stage", "1", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	n, e := strconv.Atoi(*stage)
	if e != nil || n < 1 || n > 5 || *language != "" && *language != "zh-CN" && *language != "en-US" {
		return fault.New("native_arguments_invalid", 400)
	}
	c, e := native.ReadConfiguration(*configuration)
	if e != nil {
		return e
	}
	store, e := native.NewStore(c.DataDirectory, c.Endpoint)
	if e != nil {
		return e
	}
	runtime, e := native.NewRuntime(store, c, native.ConnectionOptions{})
	if e != nil {
		return e
	}
	defer runtime.Close()
	value, e := runtime.Command(ctx, native.CommandInput{Command: *name, Language: *language, Stage: n})
	if e != nil {
		return e
	}
	return printValue(value)
}
func usage() {
	fmt.Fprintln(os.Stdout, `Galaxy Go development candidate

  galaxy native --config <absolute file>       MCP stdio
  galaxy host --config <absolute file>         Trusted host JSONL
  galaxy identity --config <absolute file>     Public local identity
  galaxy command --config <absolute file> [--command open] [--language zh-CN|en-US] [--stage 1..5]
  galaxy init|status|export [--data-dir <path>] Local fallback; no service connection
  galaxy integration-mcp [--data-dir <path>]  Local-only MCP; ignores service configuration
  galaxy integration-host [--data-dir <path>] Local-only trusted Host JSONL; no service configuration
  galaxy service-config inspect --website <HTTPS origin> [--endpoint <HTTPS origin>]
  galaxy service-config prepare --website <HTTPS origin> --endpoint <HTTPS origin> --data-dir <absolute path> --output <new absolute file>
  galaxy host-configs <absolute config> <new output directory> [--package-dir <candidate>] [--hosts <comma-separated ids>]
  galaxy setup <website URL> [--host <host id>] [--data-dir <path>] [--organization]

This candidate is incomplete. Only an explicitly reviewed setup may change a host configuration.`)
}
