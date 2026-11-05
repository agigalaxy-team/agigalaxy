//go:build linux

package nativebridge

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

var linuxTransientBootstrap bool

func readServiceBootstrap() error {
	if os.Getenv("GALAXY_NATIVE_BOOTSTRAP") != "1" {
		return nil
	}
	defer os.Stdin.Close()
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1048577))
	if err != nil || len(raw) > 1048576 {
		return errors.New("native service bootstrap unavailable")
	}
	var values []string
	if json.Unmarshal(raw, &values) != nil {
		return errors.New("native service bootstrap invalid")
	}
	os.Clearenv()
	for _, value := range values {
		name, contents, ok := strings.Cut(value, "=")
		if !ok || name == "" {
			return errors.New("native service bootstrap invalid")
		}
		if err := os.Setenv(name, contents); err != nil {
			return errors.New("native service bootstrap invalid")
		}
	}
	linuxTransientBootstrap = true
	return nil
}
