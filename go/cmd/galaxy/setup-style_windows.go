package main

import (
	"os"

	"golang.org/x/sys/windows"
)

func setupTerminalColor(output *os.File) (func(), bool) {
	handle := windows.Handle(output.Fd())
	var mode uint32
	if windows.GetConsoleMode(handle, &mode) != nil {
		return func() {}, false
	}
	if mode&windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
		return func() {}, true
	}
	if windows.SetConsoleMode(handle, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) != nil {
		return func() {}, false
	}
	return func() { _ = windows.SetConsoleMode(handle, mode) }, true
}
