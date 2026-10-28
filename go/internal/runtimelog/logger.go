package runtimelog

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Configuration struct {
	Directory   string
	Instance    string
	RotateBytes int64
	MaxFiles    int
	Environment string
}

func LoadConfiguration(env func(string) (string, bool)) (Configuration, error) {
	c := Configuration{Instance: "primary", RotateBytes: 10485760, MaxFiles: 14, Environment: "unknown"}
	if v, ok := env("GALAXY_RUNTIME_LOG_DIRECTORY"); ok {
		c.Directory = v
		if !filepath.IsAbs(v) {
			return c, fault.New("runtime_log_configuration_invalid", 500)
		}
	}
	if v, ok := env("GALAXY_RUNTIME_LOG_INSTANCE"); ok {
		c.Instance = v
	}
	if v, ok := env("GALAXY_RUNTIME_LOG_ROTATE_BYTES"); ok {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil {
			return c, fault.New("runtime_log_configuration_invalid", 500)
		}
		c.RotateBytes = n
	}
	if v, ok := env("GALAXY_RUNTIME_LOG_MAX_FILES"); ok {
		n, e := strconv.Atoi(v)
		if e != nil {
			return c, fault.New("runtime_log_configuration_invalid", 500)
		}
		c.MaxFiles = n
	}
	if v, ok := env("GALAXY_ENVIRONMENT"); ok && environments[v] {
		c.Environment = v
	}
	return c, validate(c)
}
func validate(c Configuration) error {
	if c.Directory != "" && !filepath.IsAbs(c.Directory) || !regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`).MatchString(c.Instance) || c.RotateBytes < 1024 || c.RotateBytes > 1073741824 || c.MaxFiles < 1 || c.MaxFiles > 90 {
		return fault.New("runtime_log_configuration_invalid", 500)
	}
	return nil
}

type Options struct {
	Component             string
	Configuration         Configuration
	Release               string
	Destination, Fallback io.Writer
	MaxBufferedBytes      int
	Now                   func() time.Time
	Formatter             func(Event) Event
}
type Status struct {
	Mode             string `json:"mode"`
	Ready            bool   `json:"ready"`
	WriteFailures    uint64 `json:"writeFailures"`
	DroppedRecords   uint64 `json:"droppedRecords"`
	RotationWarnings uint64 `json:"rotationWarnings"`
	Rotations        uint64 `json:"rotations"`
}
type Logger struct {
	mu                       sync.Mutex
	cond                     *sync.Cond
	options                  Options
	sink                     io.Writer
	owned                    *rotatingSink
	queue                    [][]byte
	buffered                 int
	closed, failed, reported bool
	status                   Status
	release, environment     string
	done                     chan struct{}
	closeErr                 error
}

func New(options Options) (*Logger, error) {
	if !oneOf(options.Component, "api", "worker", "migration", "content-publisher", "native", "host-client") {
		return nil, fault.New("runtime_log_component_invalid", 500)
	}
	c := options.Configuration
	if c.Instance == "" {
		c.Instance = "primary"
	}
	if c.RotateBytes == 0 {
		c.RotateBytes = 10485760
	}
	if c.MaxFiles == 0 {
		c.MaxFiles = 14
	}
	if c.Environment == "" {
		c.Environment = "unknown"
	}
	if e := validate(c); e != nil {
		return nil, e
	}
	options.Configuration = c
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Formatter == nil {
		options.Formatter = Project
	}
	if options.Fallback == nil {
		options.Fallback = os.Stderr
	}
	if options.Destination == nil {
		options.Destination = os.Stdout
	}
	if options.MaxBufferedBytes == 0 {
		options.MaxBufferedBytes = 1048576
	}
	if options.MaxBufferedBytes < 1 {
		return nil, fault.New("runtime_log_configuration_invalid", 500)
	}
	release := options.Release
	if !releasePattern.MatchString(release) {
		release = "unknown"
	}
	environment := c.Environment
	if !environments[environment] {
		environment = "unknown"
	}
	l := &Logger{options: options, sink: options.Destination, release: release, environment: environment, done: make(chan struct{}), status: Status{Mode: "stdout"}}
	if options.Destination == os.Stderr {
		l.status.Mode = "stderr"
	}
	if c.Directory != "" {
		sink, e := newRotatingSink(options.Component, c, options.Now)
		if e != nil {
			return nil, e
		}
		l.owned = sink
		l.sink = sink
		l.status.Mode = "file"
	}
	l.cond = sync.NewCond(&l.mu)
	go l.drain()
	return l, nil
}
func jsonLine(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	return b.Bytes()
}
func (l *Logger) Status() Status {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.status
	s.Ready = !l.closed && !l.failed && l.buffered < l.options.MaxBufferedBytes
	return s
}
func (l *Logger) UpdateContext(release, environment *string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if release != nil {
		l.release = "unknown"
		if releasePattern.MatchString(*release) {
			l.release = *release
		}
	}
	if environment != nil {
		l.environment = "unknown"
		if environments[*environment] {
			l.environment = *environment
		}
	}
}
func (l *Logger) report(reason string) {
	l.mu.Lock()
	if l.reported {
		l.mu.Unlock()
		return
	}
	l.reported = true
	release, environment := l.release, l.environment
	l.mu.Unlock()
	func() {
		defer func() { _ = recover() }()
		_, _ = l.options.Fallback.Write(jsonLine(Event{"event": "runtime_log_sink_unavailable", "component": l.options.Component, "release": release, "environment": environment, "time": l.options.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "reason": reason}))
	}()
}
func (l *Logger) Write(input Event) bool                             { return l.WriteContext(context.Background(), input) }
func (l *Logger) WriteContext(ctx context.Context, input Event) bool { return l.write(ctx, input, 0) }
func (l *Logger) write(ctx context.Context, input Event, level int) bool {
	selected := Event{}
	if inherited, ok := ctx.Value(fieldsKey{}).(Event); ok {
		for k, v := range inherited {
			selected[k] = v
		}
	}
	for k, v := range input {
		selected[k] = v
	}
	var formatted Event
	func() { defer func() { _ = recover() }(); formatted = l.options.Formatter(selected) }()
	if formatted == nil || text(formatted["event"]) == "" {
		l.mu.Lock()
		l.status.DroppedRecords++
		l.mu.Unlock()
		l.report("format_failed")
		return false
	}
	// Formatter output remains a projection owned by the component. Context and
	// component cannot be overwritten by untrusted per-event input.
	delete(formatted, "component")
	delete(formatted, "release")
	delete(formatted, "environment")
	if level == 0 {
		status, _ := number(formatted["status"])
		name := text(formatted["event"])
		level = 30
		if strings.HasSuffix(name, "_failed") || status >= 500 {
			level = 50
		} else if status >= 400 || strings.HasSuffix(name, "_unavailable") || strings.HasSuffix(name, "_deferred") {
			level = 40
		}
	}
	l.mu.Lock()
	formatted["component"] = l.options.Component
	formatted["release"] = l.release
	formatted["environment"] = l.environment
	formatted["level"] = level
	formatted["time"] = l.options.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	line := jsonLine(formatted)
	if l.closed || l.failed || l.buffered+len(line) > l.options.MaxBufferedBytes {
		l.status.DroppedRecords++
		l.mu.Unlock()
		l.report("buffer_or_sink_unavailable")
		return false
	}
	l.queue = append(l.queue, line)
	l.buffered += len(line)
	l.cond.Signal()
	l.mu.Unlock()
	return true
}
func (l *Logger) drain() {
	defer close(l.done)
	for {
		l.mu.Lock()
		for len(l.queue) == 0 && !l.closed {
			l.cond.Wait()
		}
		if len(l.queue) == 0 && l.closed {
			l.mu.Unlock()
			break
		}
		line := l.queue[0]
		l.queue = l.queue[1:]
		failed := l.failed
		l.mu.Unlock()
		var e error
		if !failed {
			func() {
				defer func() {
					if recover() != nil {
						e = fault.New("runtime_log_sink_failed", 500)
					}
				}()
				var n int
				n, e = l.sink.Write(line)
				if e == nil && n != len(line) {
					e = io.ErrShortWrite
				}
			}()
		}
		l.mu.Lock()
		l.buffered -= len(line)
		if failed {
			l.status.DroppedRecords++
		}
		if e != nil {
			l.failed = true
			l.status.WriteFailures++
			if l.owned != nil && l.owned.rotationFailed {
				l.status.RotationWarnings++
			}
		}
		if l.owned != nil {
			l.status.Rotations = l.owned.rotations
		}
		l.mu.Unlock()
		if e != nil {
			l.report("write_failed")
		}
	}
	if l.owned != nil {
		if e := l.owned.Close(); e != nil {
			l.mu.Lock()
			l.closeErr = fault.New("runtime_log_close_failed", 500)
			l.failed = true
			l.mu.Unlock()
			l.report("write_failed")
		}
	}
}

// Close rejects new records and drains accepted records. External stdout/stderr
// or injected streams remain owned by their caller; only file sinks are closed.
func (l *Logger) Close() error {
	l.mu.Lock()
	l.closed = true
	l.cond.Broadcast()
	l.mu.Unlock()
	<-l.done
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closeErr
}
