package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/google/uuid"
)

func candidateDirectory() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(executable), nil
}

func hostConfigurationsCommand(ctx context.Context, args []string) error {
	if len(args) < 2 {
		return fault.New("native_arguments_invalid", 400)
	}
	input := native.HostConfigurationInput{ConfigPath: args[0], Destination: args[1]}
	flags := arguments("host-configs")
	flags.StringVar(&input.PackageDirectory, "package-dir", "", "")
	hosts := flags.String("hosts", "", "")
	if flags.Parse(args[2:]) != nil || flags.NArg() != 0 {
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
	value, err := native.GenerateHostConfigurations(ctx, input)
	if err != nil {
		return err
	}
	return printValue(value)
}

// Setup presents the exact inspected plan before any identity or host-profile
// change. It does not install implicitly when stdin is absent or closed.
func setupCommand(ctx context.Context, args []string) error {
	input := native.NativeInstallationInput{SubjectType: "person"}
	for i := 0; i < len(args); i++ {
		argument := args[i]
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
	if input.Website == "" {
		return fault.New("native_arguments_invalid", 400)
	}
	reader := bufio.NewReader(os.Stdin)
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
		input.Destination = filepath.Join(home, ".galaxy-connections", input.Host+"-"+uuid.NewString()[:8])
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
	plan, err := native.PreviewNativeInstallation(ctx, input, native.ServiceConfigurationOptions{})
	if err != nil {
		return err
	}
	if err = printValue(plan); err != nil {
		return err
	}
	fmt.Fprint(os.Stderr, "确认按以上方案准备本机身份和宿主配置？[y/N] ")
	line, readErr := reader.ReadString('\n')
	confirmed := readErr == nil && (strings.EqualFold(strings.TrimSpace(line), "y") || strings.EqualFold(strings.TrimSpace(line), "yes"))
	value, err := native.PrepareNativeInstallationReviewed(ctx, plan, input.SubjectType, confirmed)
	if err != nil {
		return err
	}
	return printValue(value)
}
