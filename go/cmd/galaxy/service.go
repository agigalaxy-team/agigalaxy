package main

import (
	"context"
	"errors"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
)

func relayNative(ctx context.Context, profile nativebridge.Profile, channel nativebridge.Channel) error {
	if _, err := nativebridge.Ensure(ctx, nativebridge.Options{}); err != nil {
		return err
	}
	return nativebridge.Relay(ctx, profile, channel, os.Stdin, os.Stdout)
}

func nativeServiceCommand(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return fault.New("native_arguments_invalid", 400)
	}
	switch args[0] {
	case "run":
		return nativebridge.RunForeground(ctx)
	case "start":
		info, err := nativebridge.Ensure(ctx, nativebridge.Options{ExplicitStart: true})
		if err != nil {
			return err
		}
		return printValue(info)
	case "restart":
		info, err := nativebridge.Handover(ctx)
		if err != nil {
			return err
		}
		return printValue(info)
	case "status":
		info, err := nativebridge.Status(ctx)
		if err != nil {
			if errors.Is(err, nativebridge.ErrPaused) || errors.Is(err, nativebridge.ErrUnavailable) {
				return printValue(map[string]any{"running": false, "paused": errors.Is(err, nativebridge.ErrPaused)})
			}
			return err
		}
		return printValue(map[string]any{"running": true, "service": info})
	case "stop":
		if err := nativebridge.Stop(ctx); err != nil {
			return err
		}
		return printValue(map[string]any{"running": false, "paused": true})
	default:
		return fault.New("native_arguments_invalid", 400)
	}
}
