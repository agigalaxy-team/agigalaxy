package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

var humanOutput bool
var outputAction string
var outputDryRun bool

func run(ctx context.Context, args []string) error {
	humanOutput = false
	outputAction = ""
	outputDryRun = false
	if len(args) == 0 || len(args) == 1 && args[0] == "--json" {
		outputAction = "status"
		if info, err := os.Stdout.Stat(); err == nil {
			humanOutput = info.Mode()&os.ModeCharDevice != 0
		}
		if len(args) == 1 {
			humanOutput = false
			args = nil
		}
	} else {
		outputAction = args[0]
		switch outputAction {
		case "setup", "install", "update", "repair", "uninstall", "service", "status", "identity", "version", "--version", "help", "--help", "-h":
			if info, err := os.Stdout.Stat(); err == nil {
				humanOutput = info.Mode()&os.ModeCharDevice != 0
			}
			filtered := make([]string, 0, len(args))
			for _, arg := range args {
				if arg == "--json" {
					humanOutput = false
				} else {
					if arg == "--dry-run" {
						outputDryRun = true
					}
					filtered = append(filtered, arg)
				}
			}
			args = filtered
		}
	}
	if len(args) < 1 {
		return localCommand(ctx, "status", nil)
	}
	switch args[0] {
	case "version", "--version":
		directory, err := candidateDirectory()
		if err != nil {
			return err
		}
		version, err := updatePackageVersion(directory)
		if humanOutput && errors.Is(err, os.ErrNotExist) {
			_, err = fmt.Fprintln(os.Stdout, "当前程序未附带版本信息。")
			return err
		}
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(os.Stdout, "Galaxy "+version)
		return err
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
		if humanOutput {
			return printHumanStatus(ctx, v, false)
		}
		return printValue(map[string]any{"identity": v, "localOnly": true})
	default:
		return fault.New("native_command_unknown", 400)
	}
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx, os.Args[1:]); e != nil {
		if errors.Is(e, nativebridge.ErrPaused) {
			if humanOutput {
				fmt.Fprintln(os.Stderr, "银河服务已停止。")
			} else {
				slog.Info("galaxy service stopped", "code", "native_service_paused")
			}
			os.Exit(75)
		}
		if humanOutput {
			fmt.Fprintln(os.Stderr, "银河未能完成操作，请让当前 Agent 协助处理。")
		} else {
			slog.Error("galaxy command failed", "code", fault.Code(e))
		}
		os.Exit(1)
	}
}
