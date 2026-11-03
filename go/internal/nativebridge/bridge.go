package nativebridge

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"os"
	"path/filepath"
)

const ProtocolVersion = 1

type Profile struct {
	ConfigurationPath string `json:"configurationPath,omitempty"`
	DataDirectory     string `json:"dataDirectory,omitempty"`
	LocalOnly         bool   `json:"localOnly,omitempty"`
}
type Channel string

const (
	MCP  Channel = "mcp"
	Host Channel = "host"
)

type Info struct {
	ProtocolVersion     int            `json:"protocolVersion"`
	InstanceID          string         `json:"instanceId"`
	PID                 int            `json:"pid"`
	Endpoint            string         `json:"endpoint"`
	Executable          string         `json:"executable"`
	ReleaseID           string         `json:"releaseId,omitempty"`
	InstalledReleaseID  string         `json:"installedReleaseId,omitempty"`
	InstalledExecutable string         `json:"installedExecutable,omitempty"`
	PendingReleaseID    string         `json:"pendingReleaseId,omitempty"`
	PendingExecutable   string         `json:"pendingExecutable,omitempty"`
	SwitchState         string         `json:"switchState,omitempty"`
	ReleaseIssue        string         `json:"releaseIssue,omitempty"`
	Lifecycle           map[string]any `json:"lifecycle"`
}
type request struct {
	Version int                 `json:"version"`
	Action  string              `json:"action"`
	Profile Profile             `json:"profile,omitempty"`
	Channel Channel             `json:"channel,omitempty"`
	Input   native.CommandInput `json:"input,omitempty"`
}
type response struct {
	Info   *Info           `json:"info,omitempty"`
	Error  string          `json:"error,omitempty"`
	Status int             `json:"status,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}
type Options struct {
	Executable    string
	ExplicitStart bool
}

var ErrPaused = fault.New("native_service_paused", 409)
var ErrUnavailable = fault.New("native_service_unavailable", 503)

func paths() (string, string, string, error) {
	root, err := os.UserCacheDir()
	if err != nil {
		return "", "", "", err
	}
	dir := filepath.Join(root, "galaxy", "native-service")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", "", "", err
	}
	if err = secureDirectory(dir); err != nil {
		return "", "", "", err
	}
	return dir, endpoint(dir), filepath.Join(dir, "paused"), nil
}
