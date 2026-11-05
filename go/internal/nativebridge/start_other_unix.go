//go:build !windows && !linux

package nativebridge

import (
	"os/exec"
	"syscall"
)

func startDaemon(exe string) error {
	c := exec.Command(exe, "native-service")
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := c.Start(); err != nil {
		return err
	}
	return c.Process.Release()
}
