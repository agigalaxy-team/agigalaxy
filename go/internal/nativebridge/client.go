package nativebridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"io"
	"net"
	"os"
	"strings"
	"time"
)

func exchange(ctx context.Context, req request) (net.Conn, *bufio.Reader, response, error) {
	_, ep, _, err := paths()
	if err != nil {
		return nil, nil, response{}, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	c, err := dial(dialCtx, ep)
	if err != nil {
		return nil, nil, response{}, err
	}
	if req.Action == "status" || req.Action == "stop" {
		_ = c.SetDeadline(time.Now().Add(time.Second))
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(deadline)
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	if err = json.NewEncoder(c).Encode(req); err != nil {
		c.Close()
		return nil, nil, response{}, err
	}
	reader := bufio.NewReaderSize(c, 65536)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		c.Close()
		return nil, nil, response{}, err
	}
	var res response
	if err = json.Unmarshal(line, &res); err != nil {
		c.Close()
		return nil, nil, res, err
	}
	if res.Error != "" {
		c.Close()
		return nil, nil, res, fault.New(res.Error, res.Status)
	}
	_ = c.SetDeadline(time.Time{})
	return c, reader, res, nil
}
func Status(ctx context.Context) (Info, error) {
	c, _, r, err := exchange(ctx, request{Version: ProtocolVersion, Action: "status"})
	if err != nil {
		if !isUnavailable(err) {
			return Info{}, err
		}
		_, _, pause, e := paths()
		if e != nil {
			return Info{}, e
		}
		if _, e = os.Stat(pause); e == nil {
			return Info{}, ErrPaused
		} else if !errors.Is(e, os.ErrNotExist) {
			return Info{}, e
		}
		return Info{}, ErrUnavailable
	}
	c.Close()
	if r.Info == nil {
		return Info{}, errors.New("native service missing status")
	}
	return decorateRelease(*r.Info)
}

// Ensure respects a user pause unless ExplicitStart is set by a deliberate start action.
func Ensure(ctx context.Context, options Options) (Info, error) {
	dir, _, pause, err := paths()
	if err != nil {
		return Info{}, err
	}
	if !options.ExplicitStart {
		if _, e := os.Stat(pause); e == nil {
			return Info{}, ErrPaused
		} else if !errors.Is(e, os.ErrNotExist) {
			return Info{}, e
		}
	}
	if options.ExplicitStart {
		if _, e := os.Stat(pause); e == nil {
			deadline := time.NewTimer(5 * time.Second)
			defer deadline.Stop()
			ticker := time.NewTicker(50 * time.Millisecond)
			defer ticker.Stop()
			for {
				_, e = Status(ctx)
				if errors.Is(e, ErrPaused) || errors.Is(e, ErrUnavailable) {
					break
				}
				if e != nil {
					return Info{}, e
				}
				select {
				case <-ctx.Done():
					return Info{}, ctx.Err()
				case <-deadline.C:
					return Info{}, fault.New("native_service_still_stopping", 409)
				case <-ticker.C:
				}
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return Info{}, e
		}
		if e := os.Remove(pause); e != nil && !errors.Is(e, os.ErrNotExist) {
			return Info{}, e
		}
	}
	if info, e := Status(ctx); e == nil {
		return info, nil
	} else if !errors.Is(e, ErrUnavailable) {
		return Info{}, e
	}
	exe := options.Executable
	if exe == "" {
		exe, err = os.Executable()
		if err != nil {
			return Info{}, err
		}
	}
	exe, err = selectedExecutable(exe)
	if err != nil {
		return Info{}, err
	}
	if err = startDaemon(exe); err != nil {
		return Info{}, err
	}
	timer := time.NewTicker(50 * time.Millisecond)
	defer timer.Stop()
	timeout := time.NewTimer(12 * time.Second)
	defer timeout.Stop()
	for {
		if info, e := Status(ctx); e == nil {
			return info, nil
		} else if !errors.Is(e, ErrUnavailable) {
			return Info{}, e
		}
		select {
		case <-ctx.Done():
			return Info{}, ctx.Err()
		case <-timeout.C:
			return Info{}, fmt.Errorf("native service failed to become ready (%s)", dir)
		case <-timer.C:
		}
	}
}

// Connect never retries or replays any operation after establishing a stream.
func Connect(ctx context.Context, profile Profile, channel Channel) (io.ReadWriteCloser, error) {
	if channel != MCP && channel != Host {
		return nil, errors.New("invalid native service channel")
	}
	c, r, _, err := exchange(ctx, request{Version: ProtocolVersion, Action: "connect", Profile: profile, Channel: channel})
	if err != nil {
		return nil, err
	}
	return &bufferedConn{Conn: c, reader: r}, nil
}

// Relay keeps both directions byte-for-byte, including server-initiated MCP calls.
func Relay(ctx context.Context, p Profile, ch Channel, input io.Reader, output io.Writer) error {
	request := request{Version: ProtocolVersion, Action: "connect", Profile: p, Channel: ch, RelayControlVersion: 1}
	raw, reader, response, err := exchange(ctx, request)
	if fault.Code(err) == "native_service_draining" {
		// No host bytes were consumed or sent. Wait for the handover to finish
		// or resume, then open the first stream without replaying an operation.
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
			}
			if isUnavailable(err) {
				if _, e := Ensure(ctx, Options{}); e != nil && !errors.Is(e, ErrUnavailable) {
					return e
				}
			}
			raw, reader, response, err = exchange(ctx, request)
			if err != nil && !isUnavailable(err) && fault.Code(err) != "native_service_draining" {
				return err
			}
		}
	}
	if err != nil {
		return err
	}
	if response.RelayControlVersion == 1 {
		return relayControlled(ctx, p, ch, input, output, raw, reader, response.Info)
	}
	c := &bufferedConn{Conn: raw, reader: reader}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	inputDone := make(chan error, 1)
	go func() {
		_, e := io.Copy(c, input)
		_ = c.CloseWrite()
		inputDone <- e
	}()
	_, err = io.Copy(output, c)
	if err != nil {
		return err
	}
	select {
	case inputErr := <-inputDone:
		return inputErr
	default:
		return nil
	}
}

// Command executes the existing menu operation in the profile runtime.
func Command(ctx context.Context, p Profile, input native.CommandInput) (any, error) {
	c, _, res, err := exchange(ctx, request{Version: ProtocolVersion, Action: "command", Profile: p, Input: input})
	if err != nil {
		return nil, err
	}
	defer c.Close()
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(res.Result)))
	decoder.UseNumber()
	if err = decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

// Stop records the pause before asking the daemon to shut down.
func Stop(ctx context.Context) error {
	_, _, pause, err := paths()
	if err != nil {
		return err
	}
	if err = os.WriteFile(pause, []byte("stopped\n"), 0600); err != nil {
		return err
	}
	c, _, _, err := exchange(ctx, request{Version: ProtocolVersion, Action: "stop"})
	if err != nil {
		if isUnavailable(err) {
			return nil
		}
		return err
	}
	return c.Close()
}

// Handover explicitly restarts the core, using a prepared release when set.
// Existing sessions close and retain their original operation IDs.
func Handover(ctx context.Context) (Info, error) {
	desired, desiredErr := GetDesiredRelease()
	if desiredErr != nil && !errors.Is(desiredErr, os.ErrNotExist) {
		return Info{}, desiredErr
	}
	if desiredErr == nil {
		if _, e := selectedExecutable(""); e != nil {
			return Info{}, e
		}
	}
	ready := func(info Info, err error) (Info, error) {
		if err != nil || desiredErr != nil {
			return info, err
		}
		if info.ReleaseID != desired.ReleaseID || !sameReleaseExecutable(info.Executable, desired.Executable) {
			return info, fault.New("native_handover_target_changed", 409)
		}
		return info, nil
	}
	current, e := Status(ctx)
	if errors.Is(e, ErrPaused) || errors.Is(e, ErrUnavailable) {
		return ready(Ensure(ctx, Options{ExplicitStart: true}))
	}
	if e != nil {
		return Info{}, e
	}
	// When there is no managed release pointer, restart the running binary.
	fallback := current.Executable
	if desiredErr != nil {
		st, err := os.Stat(fallback)
		if err != nil {
			return Info{}, err
		}
		if !st.Mode().IsRegular() {
			return Info{}, fault.New("native_restart_executable_unavailable", 409)
		}
	}
	c, _, old, e := exchange(ctx, request{Version: ProtocolVersion, Action: "handover-drain"})
	if e == nil {
		_ = c.Close()
	} else if isUnavailable(e) {
		return ready(Ensure(ctx, Options{Executable: fallback}))
	} else {
		if fault.Code(e) == "native_service_action_invalid" {
			return Info{}, fault.New("native_handover_legacy_unsupported", 409)
		}
		return Info{}, e
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(12 * time.Second)
	defer timeout.Stop()
	for {
		info, statusErr := Status(ctx)
		if statusErr == nil && old.Info != nil && info.InstanceID != old.Info.InstanceID {
			return ready(info, nil)
		}
		if errors.Is(statusErr, ErrUnavailable) {
			break
		}
		if errors.Is(statusErr, ErrPaused) {
			return Info{}, ErrPaused
		}
		if statusErr != nil {
			return Info{}, statusErr
		}
		select {
		case <-ctx.Done():
			return Info{}, ctx.Err()
		case <-timeout.C:
			return Info{}, fault.New("native_service_still_stopping", 409)
		case <-ticker.C:
		}
	}
	return ready(Ensure(ctx, Options{Executable: fallback}))
}
