//go:build linux

package nativebridge

import (
	"context"
	"strings"
	"testing"
)

func TestLinuxManagerArgumentsAndSessionBoundary(t *testing.T) {
	t.Setenv("HOME", "/tmp/galaxy test")
	t.Setenv("XDG_CACHE_HOME", "/tmp/galaxy-cache")
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/other/user/bus")
	args := managerCommandArgs(1000, "/tmp/path with $value and %n/galaxy", "galaxy-native-test.service")
	joined := strings.Join(args, "\n")
	if args[len(args)-2] != "/tmp/path with $value and %n/galaxy" {
		t.Fatalf("executable path changed: %q", args[len(args)-2])
	}
	for _, want := range []string{"--user", "--service-type=exec", "--unit=galaxy-native-test.service", "--pipe", "--setenv=GALAXY_NATIVE_BOOTSTRAP=1", "/tmp/path with $value and %n/galaxy", "native-service"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q: %v", want, args)
		}
	}
	if strings.Contains(joined, "/tmp/galaxy test") || strings.Contains(joined, "/tmp/galaxy-cache") {
		t.Fatal("caller environment was passed in unit metadata")
	}
	env := bootstrapEnvironment([]string{"HOME=/tmp/home", "A2A_TOKEN=private", "XDG_SESSION_ID=old", "DBUS_SESSION_BUS_ADDRESS=other", "SYSTEMD_EXEC_PID=1"})
	if strings.Join(env, "|") != "HOME=/tmp/home|A2A_TOKEN=private" {
		t.Fatal("bootstrap filtering failed")
	}
	if strings.Contains(joined, "/other/user/bus") {
		t.Fatal("inherited another user's bus")
	}
	root := managerCommandArgs(0, "/tmp/galaxy", "galaxy-native-root.service")
	if root[0] != "--system" {
		t.Fatalf("root manager: %v", root)
	}
	ended := false
	session, err := WatchLoginSession(context.Background(), func() { ended = true })
	if err != nil || ended || session.Kind != "environment-managed" {
		t.Fatalf("session lifecycle: %+v %v", session, err)
	}
}
