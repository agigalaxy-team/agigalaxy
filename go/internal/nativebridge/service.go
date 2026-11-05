package nativebridge

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type profileState struct {
	store   *native.Store
	digest  string
	runtime *native.Runtime
	local   *native.ToolServer
	full    *native.ToolServer
}
type service struct {
	mu          sync.Mutex
	profiles    map[string]*profileState
	info        Info
	listener    net.Listener
	cancel      context.CancelFunc
	conns       map[net.Conn]struct{}
	wg          sync.WaitGroup
	artifactDir string
	lifecycle   context.Context
	ingress     map[string]bool
	relays      map[*relayDrainState]struct{}
	legacy      int
	draining    bool
}

func canonical(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fault.New("native_data_directory_must_be_absolute", 400)
	}
	path = filepath.Clean(path)
	current := path
	var tail []string
	for {
		resolved, e := filepath.EvalSymlinks(current)
		if e == nil {
			path = resolved
			for i := len(tail) - 1; i >= 0; i-- {
				path = filepath.Join(path, tail[i])
			}
			break
		}
		if !errors.Is(e, os.ErrNotExist) {
			return "", e
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", e
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}

	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return path, nil
}
func (s *service) profile(p Profile, channel Channel) (*profileState, error) {
	var conf native.Configuration
	var err error
	dir := p.DataDirectory
	if !p.LocalOnly {
		conf, err = native.ReadConfiguration(p.ConfigurationPath)
		if err != nil {
			return nil, err
		}
		dir = conf.DataDirectory
	}
	key, err := canonical(dir)
	if err != nil {
		return nil, err
	}
	profileKey := key
	if !p.LocalOnly {
		profileKey += "\x00" + conf.Endpoint
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.profiles[profileKey]
	if state == nil {
		store, e := native.NewStore(key, "")
		if e != nil {
			return nil, e
		}
		state = &profileState{store: store}
		s.profiles[profileKey] = state
	}
	if !p.LocalOnly {
		conf.DataDirectory = key
		encoded, e := json.Marshal(conf)
		if e != nil {
			return nil, e
		}
		var normalized any
		decoder := json.NewDecoder(strings.NewReader(string(encoded)))
		decoder.UseNumber()
		if e = decoder.Decode(&normalized); e != nil {
			return nil, e
		}
		encoded, e = json.Marshal(normalized)
		if e != nil {
			return nil, e
		}
		sum := sha256.Sum256(encoded)
		digest := hex.EncodeToString(sum[:])
		if state.digest != "" && state.digest != digest {
			return nil, fault.New("native_profile_configuration_conflict", 409)
		}
		if state.runtime == nil {
			store, e := native.NewStore(key, conf.Endpoint)
			if e != nil {
				return nil, e
			}
			rt, e := native.NewRuntime(store, conf, native.ConnectionOptions{})
			if e != nil {
				return nil, e
			}
			var artifacts []*native.InteractionArtifact
			if _, e := os.Stat(s.artifactDir); e == nil {
				artifact, e := native.LoadInteractionArtifact(s.artifactDir)
				if e != nil {
					rt.Close()
					return nil, e
				}
				artifacts = append(artifacts, artifact)
			} else if !errors.Is(e, os.ErrNotExist) {
				rt.Close()
				return nil, e
			}
			full, e := native.NewRuntimeToolServer(store, rt, artifacts...)
			if e != nil {
				rt.Close()
				return nil, e
			}
			state.store = store
			state.runtime = rt
			state.full = full
			state.digest = digest
			rt.ResumePrivateSync(0)
		}
	}
	if p.LocalOnly && channel == MCP && state.local == nil {
		local, e := native.NewToolServer(state.store)
		if e != nil {
			return nil, e
		}
		state.local = local
	}
	if !s.ingress[key] {
		s.ingress[key] = true
		s.wg.Add(1)
		go s.drainIngress(state.store)
	}
	snapshot := *state
	return &snapshot, nil
}

// drainIngress services local observation records even if a one-shot hook exits
// after durable enqueue but before asking the service to drain them.
func (s *service) drainIngress(store *native.Store) {
	defer s.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	lastFailure := ""
	for {
		owner, e := store.Owner(s.lifecycle)
		if e == nil && owner != "" {
			var pending bool
			pending, e = store.HasPendingHostIngress(s.lifecycle, owner)
			if e == nil && pending {
				_, e = store.DrainHostIngress(s.lifecycle, owner)
			}
		}
		if e != nil && s.lifecycle.Err() == nil {
			code := fault.Code(e)
			if code != lastFailure {
				slog.Warn("native host ingress resume failed", "code", code)
				lastFailure = code
			}
		} else if e == nil {
			lastFailure = ""
		}
		select {
		case <-s.lifecycle.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *service) handle(ctx context.Context, c net.Conn) {
	defer s.wg.Done()
	defer func() { s.mu.Lock(); delete(s.conns, c); s.mu.Unlock(); c.Close() }()
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReaderSize(c, 65536)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	var req request
	if json.Unmarshal(line, &req) != nil || req.Version != ProtocolVersion {
		_ = json.NewEncoder(c).Encode(response{Error: "native_service_protocol_mismatch", Status: 409})
		return
	}
	switch req.Action {
	case "status":
		_ = json.NewEncoder(c).Encode(response{Info: &s.info})
		return
	case "handover", "handover-drain":
		drainCtx, cancelDrain := context.WithCancel(ctx)
		defer cancelDrain()
		go func() { var b [1]byte; _, _ = c.Read(b[:]); cancelDrain() }()
		if e := s.drain(drainCtx); e != nil {
			_ = json.NewEncoder(c).Encode(response{Error: fault.Code(e), Status: fault.Status(e)})
			return
		}
		_ = json.NewEncoder(c).Encode(response{Info: &s.info})
		s.cancel()
		return
	case "stop":
		_, _, pause, e := paths()
		if e == nil {
			e = os.WriteFile(pause, []byte("stopped\n"), 0600)
		}
		if e != nil {
			_ = json.NewEncoder(c).Encode(response{Error: "native_service_pause_failed", Status: 500})
			return
		}
		_ = json.NewEncoder(c).Encode(response{Info: &s.info})
		s.cancel()
		return
	case "command", "connect-service":
		if !s.addLegacy() {
			_ = json.NewEncoder(c).Encode(response{Error: "native_service_draining", Status: 409})
			return
		}
		defer s.removeLegacy()
		if req.Profile.LocalOnly {
			_ = json.NewEncoder(c).Encode(response{Error: "native_runtime_required", Status: 400})
			return
		}
		state, e := s.profile(req.Profile, MCP)
		if e != nil {
			_ = json.NewEncoder(c).Encode(response{Error: fault.Code(e), Status: fault.Status(e)})
			return
		}
		var value any
		if req.Action == "connect-service" {
			value, e = state.runtime.ConnectService(ctx)
		} else {
			value, e = state.runtime.Command(ctx, req.Input)
		}
		if e != nil {
			_ = json.NewEncoder(c).Encode(response{Error: fault.Code(e), Status: fault.Status(e)})
			return
		}
		raw, e := json.Marshal(value)
		if e != nil {
			_ = json.NewEncoder(c).Encode(response{Error: "internal_error", Status: 500})
			return
		}
		_ = json.NewEncoder(c).Encode(response{Result: raw})
		return
	case "connect":
	default:
		_ = json.NewEncoder(c).Encode(response{Error: "native_service_action_invalid", Status: 400})
		return
	}
	if req.Channel != MCP && req.Channel != Host {
		_ = json.NewEncoder(c).Encode(response{Error: "native_service_channel_invalid", Status: 400})
		return
	}
	var relay *relayDrainState
	if req.RelayControlVersion == 1 {
		relay = newRelayDrainState(&relayPacketWriter{w: c})
		if !s.addRelay(relay) {
			_ = json.NewEncoder(c).Encode(response{Error: "native_service_draining", Status: 409})
			return
		}
		defer s.removeRelay(relay)
	} else {
		if !s.addLegacy() {
			_ = json.NewEncoder(c).Encode(response{Error: "native_service_draining", Status: 409})
			return
		}
		defer s.removeLegacy()
	}
	state, err := s.profile(req.Profile, req.Channel)
	if err != nil {
		_ = json.NewEncoder(c).Encode(response{Error: fault.Code(err), Status: fault.Status(err)})
		return
	}
	answer := response{Info: &s.info}
	var stream io.Reader = &frameReader{reader: reader}
	var output io.Writer = c
	if relay != nil {
		answer.RelayControlVersion = 1
		stream = controlledInput(ctx, reader, relay, req.Channel == Host)
		output = relayOutput{relay}
	}
	if err = json.NewEncoder(c).Encode(answer); err != nil {
		return
	}
	if relay != nil {
		relay.mu.Lock()
		relay.ready = true
		relay.signal()
		relay.mu.Unlock()
	}
	if req.Channel == Host {
		hostCtx, cancelHost := context.WithCancel(ctx)
		defer cancelHost()
		input, writer := io.Pipe()
		defer input.Close()
		go func() {
			defer writer.Close()
			buf := make([]byte, 64*1024)
			for {
				n, e := stream.Read(buf)
				if n > 0 {
					if _, writeErr := writer.Write(buf[:n]); writeErr != nil {
						return
					}
				}
				if e != nil {
					graceful := false
					if framed, ok := stream.(*frameReader); ok {
						graceful = framed.ended
					}
					if framed, ok := stream.(*controlledInputReader); ok {
						graceful = framed.ended.Load()
					}
					if !graceful {
						cancelHost()
					}
					return
				}
			}
		}()
		_ = native.ServeHost(hostCtx, state.store, input, output)
		return
	}
	var server *native.ToolServer
	if req.Profile.LocalOnly {
		server = state.local
	} else {
		server = state.full
	}
	transport := mcp.Transport(&mcp.IOTransport{Reader: io.NopCloser(stream), Writer: nopWriteCloser{output}})
	if relay != nil {
		transport = &trackedTransport{Transport: transport, state: relay, hostNotices: !req.Profile.LocalOnly}
	}
	if !req.Profile.LocalOnly {
		transport = native.HostSessionTransport(state.runtime, transport)
	}
	session, err := server.Server.Connect(ctx, transport, nil)
	if err != nil {
		return
	}
	defer session.Close()
	_ = session.Wait()
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }
