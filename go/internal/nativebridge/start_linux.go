//go:build linux

package nativebridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// userManagerEnvironment deliberately ignores inherited D-Bus/session addresses:
// sudo may retain another user's bus. The canonical socket must belong to EUID.
func userManagerEnvironment(uid int) ([]string, bool) {
	dir := filepath.Join("/run/user", strconv.Itoa(uid))
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil, false
	}
	owner, ok := st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(uid) {
		return nil, false
	}
	bus := filepath.Join(dir, "bus")
	st, err = os.Stat(bus)
	if err != nil || st.Mode()&os.ModeSocket == 0 {
		return nil, false
	}
	owner, ok = st.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(uid) {
		return nil, false
	}
	return []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "XDG_RUNTIME_DIR=" + dir, "DBUS_SESSION_BUS_ADDRESS=unix:path=" + bus}, true
}

func managerCommandArgs(uid int, exe, unit string) []string {
	args := []string{"--system"}
	if uid != 0 {
		args = []string{"--user"}
	}
	args = append(args, "--quiet", "--collect", "--pipe", "--service-type=exec", "--unit="+unit,
		"--property=Restart=no", "--setenv=GALAXY_NATIVE_BOOTSTRAP=1")
	// systemd-run sends the executable path directly as the D-Bus ExecStart
	// path, not as unit-file text. Escaping either $ or % changes that path.
	return append(args, exe, "native-service")
}

func startDaemon(exe string) error {
	uid := os.Geteuid()
	run, runErr := exec.LookPath("systemd-run")
	ctl, ctlErr := exec.LookPath("systemctl")
	env := []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
	available := runErr == nil && ctlErr == nil
	mode := "--system"
	if uid != 0 {
		mode = "--user"
		var ok bool
		env, ok = userManagerEnvironment(uid)
		available = available && ok
	}
	if available {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, ctl, mode, "show-environment")
		cmd.Env = env
		available = cmd.Run() == nil
		cancel()
	}
	if !available {
		c := exec.Command(exe, "native-service")
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "GALAXY_NATIVE_BOOTSTRAP=") {
				c.Env = append(c.Env, entry)
			}
		}
		c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := c.Start(); err != nil {
			return err
		}
		return c.Process.Release()
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	unit := "galaxy-native-" + hex.EncodeToString(random) + ".service"
	payload, err := json.Marshal(bootstrapEnvironment(os.Environ()))
	if err != nil {
		return err
	}
	cmd := exec.Command(run, managerCommandArgs(uid, exe, unit)...)
	cmd.Env = env
	cmd.Stdin = bytes.NewReader(payload)
	if err = cmd.Start(); err != nil {
		return err
	}
	// --pipe waits for the service; do not wait here. The existing socket probe
	// establishes readiness, and the child is reaped when the service ends.
	go func() { _ = cmd.Wait() }()
	return nil
}

func bootstrapEnvironment(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || strings.HasPrefix(key, "SYSTEMD_") || strings.HasPrefix(key, "LISTEN_") {
			continue
		}
		switch key {
		case "XDG_SESSION_ID", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "NOTIFY_SOCKET", "INVOCATION_ID", "JOURNAL_STREAM", "GALAXY_NATIVE_BOOTSTRAP":
			continue
		}
		out = append(out, entry)
	}
	return out
}
