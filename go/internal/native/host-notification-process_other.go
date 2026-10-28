//go:build !windows

package native

import "os/exec"

func hideHostNotificationProcess(command *exec.Cmd) {}
