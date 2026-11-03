package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
)

// Host observations can be retained before the shared service is reachable.
// Redaction and durable delivery identity belong to the existing Go store.
func hostIngressCommand(ctx context.Context, args []string) error {
	flags := arguments("ingress")
	directory := flags.String("data-dir", "", "")
	configuration := flags.String("config", os.Getenv("GALAXY_NATIVE_CONFIG"), "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	if _, err := nativebridge.Status(ctx); errors.Is(err, nativebridge.ErrPaused) {
		return err
	}
	selected, endpoint := *directory, ""
	if *configuration != "" {
		config, err := native.ReadConfiguration(*configuration)
		if err != nil {
			return err
		}
		if selected != "" && filepath.Clean(selected) != filepath.Clean(config.DataDirectory) {
			return fault.New("setup_configuration_conflict", 400)
		}
		selected, endpoint = config.DataDirectory, config.Endpoint
	}
	if selected == "" {
		selected = os.Getenv("GALAXY_DATA_DIR")
	}
	if selected == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		selected = filepath.Join(home, ".galaxy")
	}
	absolute, err := filepath.Abs(selected)
	if err != nil {
		return err
	}
	store, err := native.NewStore(absolute, endpoint)
	if err != nil {
		return err
	}
	var input native.HostIngressInput
	decoder := json.NewDecoder(os.Stdin)
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&input); err != nil {
		return fault.New("local_work_input_invalid", 400)
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return fault.New("local_work_input_invalid", 400)
	}
	result, err := native.RecordHostIngress(ctx, store, input)
	if err != nil {
		return err
	}
	return printValue(result)
}
