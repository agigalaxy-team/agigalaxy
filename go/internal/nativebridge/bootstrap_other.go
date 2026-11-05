//go:build !linux

package nativebridge

func readServiceBootstrap() error { return nil }
