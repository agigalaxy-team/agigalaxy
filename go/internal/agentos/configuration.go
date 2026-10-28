package agentos

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"unicode/utf8"
)

type Configuration struct {
	URL, SigningKey, ServiceKey string
}

func LoadConfiguration(path, endpoint string) (Configuration, error) {
	var empty Configuration
	if path == "" {
		return empty, nil
	}
	invalid := func() (Configuration, error) { return empty, fail("operations_agentos_configuration_invalid", 503) }
	if !filepath.IsAbs(path) {
		return invalid()
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > 16384 || runtime.GOOS != "windows" && before.Mode().Perm()&0007 != 0 {
		return invalid()
	}
	file, err := os.Open(path)
	if err != nil {
		return invalid()
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return invalid()
	}
	raw, err := io.ReadAll(io.LimitReader(file, 16385))
	if err != nil || len(raw) > 16384 {
		return invalid()
	}
	var wire struct {
		Version    int    `json:"version"`
		Endpoint   string `json:"endpoint"`
		URL        string `json:"url"`
		SigningKey string `json:"signingKey"`
		ServiceKey string `json:"serviceKey"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF || wire.Version != 1 || wire.Endpoint != endpoint || utf8.RuneCountInString(wire.SigningKey) < 32 || utf8.RuneCountInString(wire.SigningKey) > 4096 || utf8.RuneCountInString(wire.ServiceKey) < 32 || utf8.RuneCountInString(wire.ServiceKey) > 4096 {
		return invalid()
	}
	u, err := url.Parse(wire.URL)
	if err != nil || !validURL(u, false) || u.Path != "" && u.Path != "/" {
		return invalid()
	}
	return Configuration{URL: u.Scheme + "://" + u.Host, SigningKey: wire.SigningKey, ServiceKey: wire.ServiceKey}, nil
}
