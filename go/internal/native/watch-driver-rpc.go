package native

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type watchRPCReply struct {
	value map[string]any
	err   error
}
type watchRPC struct {
	mu, writeMu     sync.Mutex
	command, cwd    string
	args            []string
	cmd             *exec.Cmd
	stdin           io.WriteCloser
	exit            chan struct{}
	sequence        int64
	pending         map[string]chan watchRPCReply
	closed, closing bool
	failure         error
	onMessage       func(map[string]any)
	onDisconnect    func()
	closeOnce       sync.Once
	closeDone       chan struct{}
	closeError      error
}

func newWatchRPC(command, cwd string, args []string) *watchRPC {
	return &watchRPC{command: command, cwd: cwd, args: append([]string{}, args...), pending: map[string]chan watchRPCReply{}, closeDone: make(chan struct{})}
}
func (r *watchRPC) fail(e error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.failure = e
	pending := r.pending
	r.pending = map[string]chan watchRPCReply{}
	callback := r.onDisconnect
	r.mu.Unlock()
	for _, c := range pending {
		c <- watchRPCReply{err: e}
	}
	if callback != nil {
		callback()
	}
}
func (r *watchRPC) start() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.closing {
		return wdError("host_disconnected")
	}
	if r.cmd != nil {
		return nil
	}
	command := exec.Command(r.command, r.args...)
	command.Dir = r.cwd
	hideHostNotificationProcess(command)
	command.Stderr = io.Discard
	input, e := command.StdinPipe()
	if e != nil {
		return wdError("host_process_failed")
	}
	output, e := command.StdoutPipe()
	if e != nil {
		input.Close()
		return wdError("host_process_failed")
	}
	if e = command.Start(); e != nil {
		input.Close()
		output.Close()
		return wdError("host_process_failed")
	}
	r.cmd, r.stdin, r.exit = command, input, make(chan struct{})
	go func() { r.read(output); command.Wait(); close(r.exit); r.fail(wdError("host_disconnected")) }()
	return nil
}
func (r *watchRPC) send(v map[string]any) error {
	raw, e := protocol.Encode(v)
	if e != nil {
		return wdError("host_protocol_invalid")
	}
	if len(raw)+1 > 1048576 {
		return wdError("host_frame_too_large")
	}
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	r.mu.Lock()
	input, closed := r.stdin, r.closed || r.closing
	r.mu.Unlock()
	if input == nil || closed {
		return wdError("host_disconnected")
	}
	if _, e = input.Write(append(raw, '\n')); e != nil {
		r.fail(wdError("host_disconnected"))
		return wdError("host_disconnected")
	}
	return nil
}
func (r *watchRPC) read(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 65536), 1048577)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if strings.TrimSpace(string(raw)) == "" {
			continue
		}
		var message map[string]any
		if protocol.Decode(raw, &message) != nil || message == nil {
			r.fail(wdError("host_protocol_invalid"))
			r.kill()
			return
		}
		if id, exists := message["id"]; exists {
			if wdText(message["method"]) != "" {
				if e := r.send(map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "Not available in this scoped reader"}}); e != nil {
					r.fail(e)
					r.kill()
					return
				}
				continue
			}
			key := ""
			switch id := id.(type) {
			case json.Number:
				key = id.String()
			case string:
				key = id
			}
			r.mu.Lock()
			reply := r.pending[key]
			delete(r.pending, key)
			r.mu.Unlock()
			if reply != nil {
				if message["error"] != nil {
					reply <- watchRPCReply{err: wdError("host_rpc_failed")}
				} else {
					reply <- watchRPCReply{value: wdObject(message["result"])}
				}
			}
			continue
		}
		r.mu.Lock()
		callback := r.onMessage
		r.mu.Unlock()
		if callback != nil {
			callback(message)
		}
	}
	if scanner.Err() != nil {
		r.fail(wdError("host_frame_too_large"))
		r.kill()
	}
}
func (r *watchRPC) request(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	if e := r.start(); e != nil {
		return nil, e
	}
	r.mu.Lock()
	if r.closed || r.closing {
		r.mu.Unlock()
		return nil, wdError("host_disconnected")
	}
	r.sequence++
	id := r.sequence
	key := strconv.FormatInt(id, 10)
	reply := make(chan watchRPCReply, 1)
	r.pending[key] = reply
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, key); r.mu.Unlock() }()
	if e := r.send(map[string]any{"id": id, "method": method, "params": params}); e != nil {
		return nil, e
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case response := <-reply:
		return response.value, response.err
	case <-timer.C:
		return nil, wdError("host_rpc_unknown")
	case <-ctx.Done():
		return nil, wdError("host_rpc_unknown")
	}
}
func (r *watchRPC) notify(method string, params map[string]any) error {
	return r.send(map[string]any{"method": method, "params": params})
}
func (r *watchRPC) kill() {
	r.mu.Lock()
	command := r.cmd
	r.mu.Unlock()
	if command != nil && command.Process != nil {
		watchDriverTerminate(command.Process)
	}
}
func (r *watchRPC) close(ctx context.Context) error {
	r.closeOnce.Do(func() {
		go func() {
			defer close(r.closeDone)
			r.mu.Lock()
			r.closing = true
			input, exit := r.stdin, r.exit
			r.mu.Unlock()
			if input != nil {
				r.writeMu.Lock()
				input.Close()
				r.writeMu.Unlock()
			}
			if exit != nil {
				select {
				case <-exit:
				case <-time.After(2 * time.Second):
					r.kill()
					select {
					case <-exit:
					case <-time.After(2 * time.Second):
						r.closeError = wdError("host_process_shutdown_unconfirmed")
					}
				}
			}
			r.fail(wdError("host_closed"))
		}()
	})
	select {
	case <-r.closeDone:
		return r.closeError
	case <-ctx.Done():
		return wdError("host_process_shutdown_unconfirmed")
	}
}
