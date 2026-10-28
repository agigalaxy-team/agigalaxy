package runtimelog

import (
	"context"
	"log/slog"
)

type slogBridge struct {
	logger  *Logger
	attrs   []slog.Attr
	grouped bool
}

func (l *Logger) Handler() slog.Handler { return &slogBridge{logger: l} }
func (h *slogBridge) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelInfo
}
func (h *slogBridge) Handle(ctx context.Context, record slog.Record) error {
	input := Event{"event": record.Message}
	if !h.grouped {
		for _, a := range h.attrs {
			input[a.Key] = a.Value.Resolve().Any()
		}
		record.Attrs(func(a slog.Attr) bool { input[a.Key] = a.Value.Resolve().Any(); return true })
	}
	level := 30
	if record.Level >= slog.LevelError {
		level = 50
	} else if record.Level >= slog.LevelWarn {
		level = 40
	} else if record.Level < slog.LevelInfo {
		level = 20
	}
	h.logger.write(ctx, input, level)
	return nil
}
func (h *slogBridge) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &slogBridge{logger: h.logger, attrs: append(append([]slog.Attr(nil), h.attrs...), attrs...), grouped: h.grouped}
}
func (h *slogBridge) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	copy := *h
	copy.grouped = true
	return &copy
}
