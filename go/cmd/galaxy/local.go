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
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func printValue(value any) error {
	if humanOutput {
		return printHumanValue(value)
	}
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
		return relayNative(ctx, nativebridge.Profile{DataDirectory: absolute, LocalOnly: true}, nativebridge.Host)
	case "integration-mcp":
		return relayNative(ctx, nativebridge.Profile{DataDirectory: absolute, LocalOnly: true}, nativebridge.MCP)
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
	if humanOutput && name == "status" {
		status, ok := value.(map[string]any)
		if !ok {
			return fault.New("native_status_invalid", 500)
		}
		identity, _ := status["identity"].(map[string]any)
		return printHumanStatus(ctx, identity, status["recoveryRequired"] == true)
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
	flags.StringVar(&request.RootPinsFile, "root-pins-file", "", "")
	flags.StringVar(&request.TrustDirectory, "trust-directory", "", "")
	flags.StringVar(&request.NetworkType, "network-type", "", "")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	var value any
	var e error
	if args[0] == "inspect" {
		if request.DataDirectory != "" || request.Output != "" || request.RootPinsFile != "" || request.TrustDirectory != "" || request.NetworkType != "" {
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
	_, e = native.ReadConfiguration(*configuration)
	if e != nil {
		return e
	}
	if _, e = nativebridge.Ensure(ctx, nativebridge.Options{}); e != nil {
		return e
	}
	value, e := nativebridge.Command(ctx, nativebridge.Profile{ConfigurationPath: *configuration}, native.CommandInput{Command: *name, Language: *language, Stage: n})
	if e != nil {
		return e
	}
	return printValue(value)
}
func usage() {
	fmt.Fprintln(os.Stdout, `Galaxy 客户端

  galaxy version                               显示客户端版本
  状态、身份及安装维护命令在终端显示简明结果；使用 --json 获取机器可读结果。

  galaxy native --config <absolute file>       MCP stdio
  galaxy host --config <absolute file>         Trusted host JSONL
  galaxy identity --config <absolute file>     Public local identity
  galaxy command --config <absolute file> [--command open] [--language zh-CN|en-US] [--stage 1..5]
  galaxy init|status|export [--data-dir <path>] Local fallback; no service connection
  galaxy integration-mcp [--data-dir <path>]  Local-only MCP; ignores service configuration
  galaxy integration-host [--data-dir <path>] Local-only trusted Host JSONL; no service configuration
  galaxy service-config inspect --website <HTTPS origin> [--endpoint <HTTPS origin>]
  galaxy service-config prepare --website <HTTPS origin> --endpoint <HTTPS origin> --data-dir <absolute path> --output <new absolute file> [--root-pins-file <absolute JSON> --trust-directory <absolute path>] [--network-type official|hub]
  galaxy host-configs <absolute config> <new output directory> [--package-dir <release>] [--hosts <comma-separated ids>]
  galaxy host-configs <new output directory> --local-only [--data-dir <path>] [--hosts <comma-separated ids>]
  galaxy setup <website URL> [--host <host id>] [--data-dir <path>] [--organization] [--sync-tier <1-4>]
  galaxy setup --local-only [--host <host id>] [--data-dir <path>] [--organization] [--sync-tier <1-4>]
  galaxy service start|status|stop|restart|run    Shared local runtime; no login autostart
  galaxy install|update|repair [--host <id>] [--package-dir <release>] [--install-root <path>] [--data-dir <path>] [--config <file>|--local-only] [--dry-run]
  galaxy update checks the official release when --package-dir is omitted. Use --restart-legacy after closing old host connections if handover is unsupported.
  galaxy uninstall --host <id> [--install-root <path>]  Remove host integration; keep owned data
  galaxy install --mcp-config <file> --skill-dir <dir> --mcp-format json-mcpServers|json-servers|toml-mcp_servers [--local-only]
  galaxy ingress [--config <file>|--data-dir <path>]    Persist one host observation from stdin

install configures the selected host for the current system user. Existing identity and local records are preserved.`)
}
