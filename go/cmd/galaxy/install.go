package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
)

func candidateDirectory() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(executable), nil
}

func hostConfigurationsCommand(ctx context.Context, args []string) error {
	localOnly := slices.Contains(args, "--local-only")
	if len(args) < 1 || !localOnly && len(args) < 2 {
		return fault.New("native_arguments_invalid", 400)
	}
	input := native.HostConfigurationInput{}
	remaining := args[1:]
	if localOnly {
		input.Destination = args[0]
	} else {
		input.ConfigPath, input.Destination = args[0], args[1]
		remaining = args[2:]
	}
	flags := arguments("host-configs")
	flags.BoolVar(&input.LocalOnly, "local-only", false, "")
	flags.StringVar(&input.DataDirectory, "data-dir", "", "")
	flags.StringVar(&input.PackageDirectory, "package-dir", "", "")
	hosts := flags.String("hosts", "", "")
	if flags.Parse(remaining) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "hosts" {
			input.Hosts = []string{}
			if *hosts != "" {
				input.Hosts = strings.Split(*hosts, ",")
			}
		}
	})
	var err error
	if input.PackageDirectory == "" {
		input.PackageDirectory, err = candidateDirectory()
		if err != nil {
			return err
		}
	}
	if input.LocalOnly {
		if input.DataDirectory == "" {
			input.DataDirectory = os.Getenv("GALAXY_DATA_DIR")
		}
		if input.DataDirectory == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			input.DataDirectory = filepath.Join(home, ".galaxy")
		}
		input.DataDirectory, err = filepath.Abs(input.DataDirectory)
		if err != nil {
			return err
		}
	} else {
		// OpenCode's TUI and its MCP server must use the SAME selected store.
		// The public configuration is the owner of that location and endpoint.
		if input.DataDirectory != "" {
			return fault.New("native_arguments_invalid", 400)
		}
		if slices.Contains(input.Hosts, "opencode") {
			configuration, err := native.ReadConfiguration(input.ConfigPath)
			if err != nil {
				return err
			}
			input.DataDirectory, input.Endpoint = configuration.DataDirectory, configuration.Endpoint
		}
	}
	value, err := native.GenerateHostConfigurations(ctx, input)
	if err != nil {
		return err
	}
	return printValue(value)
}

// Setup checks the installation before applying the explicitly requested setup.
func setupCommand(ctx context.Context, args []string) error {
	input := native.NativeInstallationInput{SubjectType: "person"}
	for i := 0; i < len(args); i++ {
		argument := args[i]
		if argument == "--local-only" {
			input.LocalOnly = true
			continue
		}
		if argument == "--organization" {
			input.SubjectType = "organization"
			continue
		}
		if strings.HasPrefix(argument, "--") {
			if i+1 >= len(args) {
				return fault.New("native_arguments_invalid", 400)
			}
			i++
			value := args[i]
			switch argument {
			case "--host":
				input.Host = value
			case "--data-dir":
				input.DataDirectory = value
			case "--destination":
				input.Destination = value
			case "--package-dir":
				input.PackageDirectory = value
			case "--opencode":
				input.OpenCodePath = value
			case "--opencode-config-dir":
				input.OpenCodeConfigDirectory = value
			default:
				return fault.New("native_arguments_invalid", 400)
			}
			continue
		}
		if input.Website != "" {
			return fault.New("native_arguments_invalid", 400)
		}
		input.Website = argument
	}
	if input.Website == "" && !input.LocalOnly || input.Website != "" && input.LocalOnly {
		return fault.New("native_arguments_invalid", 400)
	}
	reader := bufio.NewReader(os.Stdin)
	if input.Host == "" {
		detected := native.DetectCurrentNativeHost(installationEnvironment())
		if len(detected) == 1 {
			input.Host = detected[0]
		}
	}
	if input.Host == "" {
		hosts := native.HostConfigurationOptions()
		for index, host := range hosts {
			fmt.Fprintf(os.Stderr, "%d. %s\n", index+1, host["label"])
		}
		fmt.Fprint(os.Stderr, "请选择宿主编号：")
		line, err := reader.ReadString('\n')
		if err != nil {
			return fault.New("setup_choice_required", 400)
		}
		index, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || index < 1 || index > len(hosts) {
			return fault.New("setup_host_invalid", 400)
		}
		input.Host = hosts[index-1]["id"]
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if input.DataDirectory == "" {
		input.DataDirectory = os.Getenv("GALAXY_DATA_DIR")
	}
	if input.DataDirectory == "" {
		input.DataDirectory = filepath.Join(home, ".galaxy")
	}
	input.DataDirectory, err = filepath.Abs(input.DataDirectory)
	if err != nil {
		return err
	}
	if input.Destination == "" {
		input.Destination = defaultClientRoot(home)
	}
	input.Destination, err = filepath.Abs(input.Destination)
	if err != nil {
		return err
	}
	if input.PackageDirectory == "" {
		input.PackageDirectory, err = candidateDirectory()
		if err != nil {
			return err
		}
	}
	if input.Host == "opencode" {
		input.DefaultOpenCodeConfigDirectory, err = native.OpenCodeConfigurationDirectory(map[string]string{"OPENCODE_CONFIG_DIR": os.Getenv("OPENCODE_CONFIG_DIR"), "XDG_CONFIG_HOME": os.Getenv("XDG_CONFIG_HOME")}, home)
		if err != nil {
			return err
		}
		if input.OpenCodeConfigDirectory == "" {
			input.OpenCodeConfigDirectory = input.DefaultOpenCodeConfigDirectory
		}
		input.OpenCodeConfigDirectory, err = filepath.Abs(input.OpenCodeConfigDirectory)
		if err != nil {
			return err
		}
		input.OpenCodePath, err = native.FindOpenCodeExecutable(input.OpenCodePath, os.Getenv("PATH"))
		if err != nil {
			return err
		}
	}
	unlock, err := nativebridge.WaitUpdate(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	input.PackageDirectory, err = preferSelectedRelease(ctx, input.PackageDirectory)
	if err != nil {
		return err
	}
	// Both discovery and configuration preparation may encounter the same
	// temporary outage. Only that specific failure uses the local install path.
	website := ""
	if !input.LocalOnly {
		website, err = native.InstallationWebsiteOrigin(input.Website)
		if err != nil {
			return err
		}
	}
	plan, discoveryError := native.PreviewNativeInstallation(ctx, input, native.ServiceConfigurationOptions{})
	configurationPath := ""
	if discoveryError == nil && !input.LocalOnly {
		profile := sha256.Sum256([]byte(plan.Endpoint + "\n" + input.DataDirectory))
		configurationPath = filepath.Join(input.Destination, "connections", fmt.Sprintf("service-%x.json", profile[:8]))
		if _, err := os.Stat(configurationPath); os.IsNotExist(err) {
			if err = os.MkdirAll(filepath.Dir(configurationPath), 0700); err != nil {
				return err
			}
			_, discoveryError = native.PrepareServiceConfiguration(ctx, native.ServiceConfigurationRequest{Website: plan.Website, Endpoint: plan.Endpoint, DataDirectory: input.DataDirectory, Output: configurationPath}, native.ServiceConfigurationOptions{})
		} else if err != nil {
			return err
		}
	}
	pending := discoveryError != nil && fault.Code(discoveryError) == "native_service_configuration_temporarily_unavailable" && ctx.Err() == nil
	if discoveryError != nil && !pending {
		return discoveryError
	}
	environment := installationEnvironment()
	if input.OpenCodeConfigDirectory != "" {
		environment["OPENCODE_CONFIG_DIR"] = input.OpenCodeConfigDirectory
	}
	node, _ := exec.LookPath("node")
	if node != "" {
		node, err = filepath.Abs(node)
		if err != nil {
			return err
		}
	}
	managedInput := native.ManagedNativeInstallationInput{Host: input.Host, Home: home, Environment: environment, PackageDirectory: input.PackageDirectory, InstallRoot: input.Destination, DataDirectory: input.DataDirectory, ConfigPath: configurationPath, LocalOnly: input.LocalOnly, SubjectType: input.SubjectType, NodeExecutable: node, HostExecutable: input.OpenCodePath}
	if pending {
		// Preserve an existing host's configured connection. For a new host,
		// install its local tools and keep the selected website in the record.
		managedInput.ConfigPath = ""
		managedInput.LocalOnly = true
		existing, resolveErr := native.ResolveManagedNativeMaintenance(managedInput, map[string]bool{"data-dir": true, "package-dir": true})
		if resolveErr == nil {
			managedInput.ConfigPath, managedInput.LocalOnly, managedInput.Endpoint = existing.ConfigPath, existing.LocalOnly, existing.Endpoint
		} else if fault.Code(resolveErr) != "setup_installation_missing" {
			return resolveErr
		}
		managedInput.PendingWebsite = website
	}
	managed, err := native.PreviewManagedNativeInstallation(ctx, managedInput)
	if err != nil {
		return err
	}

	value, applyError := native.ApplyManagedNativeInstallation(ctx, managed)
	if pending && value != nil && value["releaseInstalled"] == true && value["hostConfigured"] == true {
		value["installed"] = true
		value["serviceConnection"] = "pending"
		value["pendingWebsite"] = website
	}
	return completeManagedInstallation(ctx, value, applyError, !input.LocalOnly && !pending, configurationPath)
}
