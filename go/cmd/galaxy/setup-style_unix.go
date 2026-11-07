//go:build !windows

package main

import "os"

func setupTerminalColor(_ *os.File) (func(), bool) {
	return func() {}, os.Getenv("TERM") != ""
}
