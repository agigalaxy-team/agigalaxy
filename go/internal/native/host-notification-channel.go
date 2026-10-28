package native

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/google/uuid"
)

type HostNotificationShow struct {
	PromptID            string
	EventCount          int
	IsCurrent           func() bool
	OnClicked, OnClosed func()
}

// HostNotificationChannel is a trusted platform adapter. Only generic count and
// original prompt IDs cross this boundary; source bodies never enter it.
type HostNotificationChannel interface {
	Kind() string
	Capabilities(context.Context) (map[string]any, error)
	Permission(context.Context, func() bool) (map[string]any, error)
	Show(context.Context, HostNotificationShow) (map[string]any, error)
	Withdraw(context.Context, string) error
	Close(context.Context) error
}
type hostNotificationProcess struct {
	id                                  string
	command                             *exec.Cmd
	input                               io.WriteCloser
	result                              chan map[string]any
	done                                chan struct{}
	stopOnce                            sync.Once
	mu                                  sync.Mutex
	displayed, accepted, recall, absent bool
	notificationID                      any
}
type configuredHostNotificationChannel struct {
	kind, command, helper string
	mu                    sync.Mutex
	closed                bool
	entries               map[string]*hostNotificationProcess
}

var macNotificationCommand = regexp.MustCompile(`[/\\]GalaxyNotifications\.app[/\\]Contents[/\\]MacOS[/\\]GalaxyNotifications$`)
var linuxNotificationOwner = regexp.MustCompile(`^:[0-9]+\.[0-9]+$`)

func NewConfiguredHostNotificationChannel(raw []byte) (HostNotificationChannel, error) {
	kind := "windows-notify-icon"
	if runtime.GOOS == "linux" {
		kind = "linux-freedesktop"
	} else if runtime.GOOS == "darwin" {
		kind = "macos-user-notifications"
	}
	config := map[string]any{}
	if len(raw) > 0 {
		if json.Unmarshal(raw, &config) != nil || config == nil {
			return nil, connectionFailure("notification_runtime_configuration_invalid")
		}
		for k := range config {
			if k != "kind" && k != "command" {
				return nil, connectionFailure("notification_runtime_configuration_invalid")
			}
		}
		kind = text(config["kind"])
	}
	if !isOne(kind, "windows-notify-icon", "linux-freedesktop", "macos-user-notifications") {
		return nil, connectionFailure("notification_runtime_configuration_invalid")
	}
	command := text(config["command"])
	if command != "" && !filepath.IsAbs(command) {
		return nil, connectionFailure("notification_command_must_be_absolute")
	}
	if kind == "macos-user-notifications" && command != "" && !macNotificationCommand.MatchString(command) {
		return nil, connectionFailure("notification_bundled_command_invalid")
	}
	executable, e := os.Executable()
	if e != nil {
		return nil, e
	}
	helper := filepath.Join(filepath.Dir(executable), "notifications", "windows-notify-icon.ps1")
	if command == "" {
		if kind == "linux-freedesktop" {
			command = "/usr/bin/python3"
		} else if kind == "windows-notify-icon" && os.Getenv("SystemRoot") != "" {
			command = filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		}
	}
	return &configuredHostNotificationChannel{kind: kind, command: command, helper: helper, entries: map[string]*hostNotificationProcess{}}, nil
}
func (h *configuredHostNotificationChannel) Kind() string { return h.kind }
func notificationUnknown(reason string) map[string]any {
	return map[string]any{"state": "unknown", "reason": reason, "displayed": false, "humanReadChanged": false, "agentCursorChanged": false}
}
func (h *configuredHostNotificationChannel) available() string {
	if h.kind == "windows-notify-icon" && runtime.GOOS != "windows" {
		return "windows_channel_not_available"
	}
	if h.kind == "linux-freedesktop" && runtime.GOOS != "linux" {
		return "linux_channel_not_available"
	}
	if h.kind == "macos-user-notifications" && runtime.GOOS != "darwin" {
		return "macos_channel_not_available"
	}
	if h.command == "" {
		if h.kind == "macos-user-notifications" {
			return "macos_bundled_helper_required"
		}
		return "notification_process_unavailable"
	}
	return ""
}
func (h *configuredHostNotificationChannel) open(ctx context.Context, mode string, show HostNotificationShow) (map[string]any, error) {
	if reason := h.available(); reason != "" {
		return map[string]any{"state": "unavailable", "available": false, "reason": reason, "displayed": false}, nil
	}
	if show.PromptID == "" {
		show.PromptID = uuid.NewString()
	}
	if mode == "show" && (!controlUUID(show.PromptID) || show.EventCount < 1 || show.EventCount > 20) {
		return nil, connectionFailure("notification_prompt_invalid")
	}
	if show.IsCurrent == nil {
		show.IsCurrent = func() bool { return true }
	}
	if !show.IsCurrent() {
		return notificationUnknown("notification_cancelled"), nil
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return map[string]any{"available": false, "state": "unavailable", "reason": "notification_channel_closed"}, nil
	}
	if len(h.entries) >= 64 {
		h.mu.Unlock()
		return notificationUnknown("notification_process_capacity"), nil
	}
	if old := h.entries[show.PromptID]; old != nil {
		h.mu.Unlock()
		return nil, connectionFailure("notification_prompt_already_owned")
	}
	p := &hostNotificationProcess{id: show.PromptID, result: make(chan map[string]any, 1), done: make(chan struct{})}
	h.entries[p.id] = p
	h.mu.Unlock()
	finish := func(value map[string]any) {
		select {
		case p.result <- value:
		default:
		}
	}
	cleanup := func() {
		h.mu.Lock()
		delete(h.entries, p.id)
		h.mu.Unlock()
		close(p.done)
		finish(notificationUnknown("notification_process_closed"))
		if show.OnClosed != nil {
			show.OnClosed()
		}
	}
	args := []string{}
	switch h.kind {
	case "windows-notify-icon":
		args = []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-File", h.helper}
		if _, e := os.Stat(h.helper); e != nil {
			cleanup()
			return map[string]any{"available": false, "state": "unavailable", "reason": "notification_process_unavailable", "displayed": false}, nil
		}
	case "linux-freedesktop":
		args = []string{"-I", "-c", hostNotificationLinuxHelper}
	case "macos-user-notifications":
		args = []string{"--stdio-v1"}
	}
	command := exec.Command(h.command, args...)
	hideHostNotificationProcess(command)
	input, e := command.StdinPipe()
	if e != nil {
		cleanup()
		return notificationUnknown("notification_process_unavailable"), nil
	}
	output, e := command.StdoutPipe()
	if e != nil {
		_ = input.Close()
		cleanup()
		return notificationUnknown("notification_process_unavailable"), nil
	}
	command.Stderr = io.Discard
	p.mu.Lock()
	p.command = command
	p.input = input
	p.mu.Unlock()
	if !show.IsCurrent() {
		_ = input.Close()
		cleanup()
		return notificationUnknown("notification_cancelled"), nil
	}
	if e = command.Start(); e != nil {
		_ = input.Close()
		cleanup()
		return map[string]any{"available": false, "state": "unavailable", "reason": "notification_process_unavailable", "displayed": false}, nil
	}
	go func() {
		defer cleanup()
		scanner := bufio.NewScanner(io.LimitReader(output, 8193))
		scanner.Buffer(make([]byte, 1024), 8193)
		total := 0
		invalid := false
		for scanner.Scan() {
			line := scanner.Bytes()
			total += len(line) + 1
			event, decodeError := connectionObject(line)
			if total > 8192 || decodeError != nil || event == nil {
				invalid = true
				break
			}
			if h.kind != "windows-notify-icon" && (integer(event["version"]) != 1 || h.kind == "macos-user-notifications" && event["bundleId"] != "org.galaxy.local-notifications") {
				invalid = true
				break
			}
			tag := text(event["event"])
			switch {
			case tag == "capabilities" && isOne(mode, "probe", "permission"):
				valid := false
				if h.kind == "windows-notify-icon" {
					valid = mode == "probe" && event["available"] == true && event["channel"] == h.kind && event["displayEvidence"] == "BalloonTipShown" && event["permission"] == "system-managed"
				} else if h.kind == "linux-freedesktop" {
					valid = mode == "probe" && event["available"] == true && event["channel"] == h.kind && event["displayEvidence"] == "none" && event["permission"] == "system-managed" && event["recall"] == "same-connection-original-id"
				} else {
					_, boolean := event["available"].(bool)
					valid = boolean && event["channel"] == h.kind && event["displayEvidence"] == "none" && event["recall"] == "app-original-identifier" && isOne(text(event["permission"]), "authorized", "denied", "not-determined", "unknown") && (event["available"] == false || event["permission"] == "authorized" && event["alertsEnabled"] == true)
				}
				if !valid {
					invalid = true
					break
				}
				if show.IsCurrent() {
					v := map[string]any{"available": event["available"], "channel": h.kind, "displayEvidence": event["displayEvidence"], "permission": event["permission"], "processStarted": true}
					if h.kind != "windows-notify-icon" {
						v["recall"] = event["recall"]
					}
					if h.kind == "macos-user-notifications" {
						v["alertsEnabled"] = event["alertsEnabled"] == true
						if event["available"] == false {
							v["reason"] = "macos_notification_permission_required"
						}
					}
					finish(v)
				}
			case mode == "show" && tag == "accepted":
				p.mu.Lock()
				already := p.accepted
				p.mu.Unlock()
				valid := !already
				if h.kind == "linux-freedesktop" {
					n := integer(event["notificationId"])
					valid = valid && n > 0 && n <= 4294967295 && linuxNotificationOwner.MatchString(text(event["owner"])) && event["sameConnection"] == true && event["evidence"] == "org.freedesktop.Notifications.Notify reply"
				} else if h.kind == "macos-user-notifications" {
					valid = valid && event["notificationId"] == p.id && event["evidence"] == "UNUserNotificationCenter.add-completion"
				}
				if !valid {
					invalid = true
					break
				}
				p.mu.Lock()
				p.accepted = true
				p.notificationID = event["notificationId"]
				p.mu.Unlock()
				if h.kind != "windows-notify-icon" && show.IsCurrent() {
					v := notificationUnknown("notification_display_unconfirmed")
					v["promptId"] = p.id
					v["systemAccepted"] = true
					v["acceptanceEvidence"] = event["evidence"]
					v["foregroundFallbackRequired"] = true
					finish(v)
				}
			case h.kind == "windows-notify-icon" && mode == "show" && tag == "shown" && event["evidence"] == "BalloonTipShown":
				p.mu.Lock()
				p.displayed = true
				p.mu.Unlock()
				finish(map[string]any{"state": "shown", "displayed": true, "evidence": "BalloonTipShown", "promptId": p.id, "humanReadChanged": false})
			case h.kind == "windows-notify-icon" && mode == "show" && tag == "clicked":
				p.mu.Lock()
				displayed := p.displayed
				p.mu.Unlock()
				if displayed && show.IsCurrent() && show.OnClicked != nil {
					go show.OnClicked()
				}
			case tag == "withdrawn" && mode == "show" && h.kind != "windows-notify-icon":
				_, boolean := event["requested"].(bool)
				p.mu.Lock()
				valid := boolean
				if h.kind == "linux-freedesktop" {
					valid = valid && event["sameConnection"] == true && connectionEqual(event["notificationId"], p.notificationID)
				} else {
					_, absence := event["observedAbsence"].(bool)
					valid = valid && absence && event["notificationId"] == p.id && (event["observedAbsence"] != true || event["requested"] == true)
				}
				if valid {
					p.recall = event["requested"] == true
					p.absent = event["observedAbsence"] == true
				}
				p.mu.Unlock()
				if !valid {
					invalid = true
				}
			case tag == "unavailable":
				reason := "windows_notification_unavailable"
				if h.kind == "linux-freedesktop" {
					if event["reason"] != "linux_notification_service_unavailable" {
						invalid = true
						break
					}
					reason = text(event["reason"])
				} else if h.kind == "macos-user-notifications" {
					reason = text(event["reason"])
					if !isOne(reason, "macos_notification_permission_required", "macos_notification_service_unavailable", "macos_notification_bundle_required", "macos_notification_input_invalid") {
						invalid = true
						break
					}
				}
				finish(map[string]any{"state": "unavailable", "reason": reason, "displayed": false})
			case tag == "closed" || h.kind == "windows-notify-icon" && isOne(tag, "dismissed", "closed"):
			default:
				invalid = true
			}
			if invalid {
				break
			}
			if !show.IsCurrent() {
				finish(notificationUnknown("notification_cancelled"))
				break
			}
		}
		if invalid || scanner.Err() != nil {
			finish(notificationUnknown("notification_protocol_invalid"))
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	}()
	request := map[string]any{"mode": mode}
	if mode == "show" {
		request["eventCount"] = show.EventCount
		if h.kind == "windows-notify-icon" {
			request["testOnly"] = false
		} else if h.kind == "macos-user-notifications" {
			request["promptId"] = p.id
		}
	}
	if h.kind == "macos-user-notifications" {
		request["version"] = 1
	}
	raw, _ := json.Marshal(request)
	_, _ = input.Write(append(raw, '\n'))
	timeout := 18 * time.Second
	if h.kind != "windows-notify-icon" {
		timeout = 28 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	go func() {
		select {
		case <-ctx.Done():
			_ = h.stop(context.Background(), p)
		case <-p.done:
		}
	}()
	select {
	case value := <-p.result:
		if mode != "show" || value["systemAccepted"] != true && value["displayed"] != true {
			_ = h.stop(context.Background(), p)
		}
		return value, nil
	case <-ctx.Done():
		_ = h.stop(context.Background(), p)
		return notificationUnknown("notification_cancelled"), nil
	case <-timer.C:
		_ = h.stop(context.Background(), p)
		return notificationUnknown("notification_process_timeout"), nil
	}
}
func (h *configuredHostNotificationChannel) stop(ctx context.Context, p *hostNotificationProcess) error {
	p.stopOnce.Do(func() {
		p.mu.Lock()
		input := p.input
		p.mu.Unlock()
		if input != nil {
			line := "{\"mode\":\"close\"}\n"
			if h.kind == "windows-notify-icon" {
				line = "close\n"
			} else if h.kind == "macos-user-notifications" {
				line = "{\"version\":1,\"mode\":\"close\"}\n"
			}
			_, _ = io.WriteString(input, line)
		}
	})
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1500 * time.Millisecond):
	}
	p.mu.Lock()
	command := p.command
	p.mu.Unlock()
	if command != nil && command.Process != nil {
		_ = command.Process.Kill()
	}
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1500 * time.Millisecond):
		return connectionFailure("notification_process_shutdown_unconfirmed")
	}
}
func (h *configuredHostNotificationChannel) Capabilities(ctx context.Context) (map[string]any, error) {
	return h.open(ctx, "probe", HostNotificationShow{})
}
func (h *configuredHostNotificationChannel) Permission(ctx context.Context, current func() bool) (map[string]any, error) {
	if h.kind != "macos-user-notifications" {
		return map[string]any{"available": false, "reason": "notification_permission_request_unsupported"}, nil
	}
	return h.open(ctx, "permission", HostNotificationShow{IsCurrent: current})
}
func (h *configuredHostNotificationChannel) Show(ctx context.Context, input HostNotificationShow) (map[string]any, error) {
	return h.open(ctx, "show", input)
}
func (h *configuredHostNotificationChannel) Withdraw(ctx context.Context, id string) error {
	h.mu.Lock()
	p := h.entries[id]
	h.mu.Unlock()
	if p == nil {
		return nil
	}
	return h.stop(ctx, p)
}
func (h *configuredHostNotificationChannel) Close(ctx context.Context) error {
	h.mu.Lock()
	h.closed = true
	entries := []*hostNotificationProcess{}
	for _, p := range h.entries {
		entries = append(entries, p)
	}
	h.mu.Unlock()
	var first error
	for _, p := range entries {
		if e := h.stop(ctx, p); e != nil && first == nil {
			first = e
		}
	}
	return first
}
