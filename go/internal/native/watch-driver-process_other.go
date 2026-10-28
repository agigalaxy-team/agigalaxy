//go:build !windows

package native

import (
	"os"
	"syscall"
)

func watchDriverTerminate(process *os.Process) error { return process.Signal(syscall.SIGTERM) }
