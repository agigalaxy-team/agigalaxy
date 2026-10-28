package native

import (
	"os/exec"
	"syscall"
)

func hideHostNotificationProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
