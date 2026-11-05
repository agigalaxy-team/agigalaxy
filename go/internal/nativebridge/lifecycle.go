package nativebridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"github.com/gofrs/flock"
	"net"
	"os"
	"path/filepath"
	"time"
)

// RunForeground is an explicit user start for containers and process managers.
// Automatic thin clients keep using Ensure and continue to respect a pause.
func RunForeground(ctx context.Context) error { return run(ctx, true) }

// Run owns the process lock and all profile runtimes until explicit stop or context cancellation.
func Run(ctx context.Context) error {
	if err := readServiceBootstrap(); err != nil {
		return err
	}
	return run(ctx, false)
}

func run(ctx context.Context, foreground bool) error {
	dir, ep, pause, err := paths()
	if err != nil {
		return err
	}
	lock := flock.New(filepath.Join(dir, "service.lock"))
	var acquired bool
	if foreground {
		acquired, err = lock.TryLock()
	} else {
		wait, cancelWait := context.WithTimeout(ctx, 5*time.Second)
		acquired, err = lock.TryLockContext(wait, 50*time.Millisecond)
		cancelWait()
	}
	if err != nil {
		return err
	}
	if !acquired {
		return errors.New("native service already running")
	}
	defer lock.Unlock()
	if foreground {
		if e := os.Remove(pause); e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	if _, e := os.Stat(pause); e == nil {
		return ErrPaused
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	id := make([]byte, 16)
	if _, err = rand.Read(id); err != nil {
		return err
	}
	lifecycle, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &service{profiles: make(map[string]*profileState), conns: make(map[net.Conn]struct{}), cancel: cancel, lifecycle: lifecycle, ingress: map[string]bool{}, info: Info{ProtocolVersion: ProtocolVersion, InstanceID: hex.EncodeToString(id), PID: os.Getpid(), Endpoint: ep}}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	s.info.Executable = exe
	s.info.ReleaseID = releaseID(exe)
	session, sessionErr := WatchLoginSession(lifecycle, cancel)
	if sessionErr != nil {
		s.info.Lifecycle = map[string]any{"mode": "unavailable", "reason": sessionErr.Error()}
	} else if session.Kind == "systemd-transient" {
		s.info.Lifecycle = map[string]any{"mode": "managed", "manager": session.Kind}
	} else if session.Kind == "environment-managed" {
		s.info.Lifecycle = map[string]any{"mode": "environment-managed"}
	} else {
		s.info.Lifecycle = map[string]any{"mode": "observed", "session": session}
	}
	s.artifactDir = filepath.Join(filepath.Dir(exe), "dist")
	if err = lifecycle.Err(); err != nil {
		return err
	}
	if _, e := os.Stat(pause); e == nil {
		return ErrPaused
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	listener, err := listen(ep)
	if err != nil {
		return err
	}
	s.listener = listener
	defer listener.Close()
	defer cleanupEndpoint(ep)
	// A stop may have been recorded between the earlier pause check and listen.
	if _, e := os.Stat(pause); e == nil {
		return ErrPaused
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	go func() {
		<-lifecycle.Done()
		listener.Close()
		s.mu.Lock()
		for c := range s.conns {
			c.Close()
		}
		s.mu.Unlock()
	}()
	var acceptErr error
	for {
		c, e := listener.Accept()
		if e != nil {
			if lifecycle.Err() != nil {
				break
			}
			acceptErr = e
			cancel()
			break
		}
		s.mu.Lock()
		if lifecycle.Err() != nil {
			s.mu.Unlock()
			c.Close()
			break
		}
		s.conns[c] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go s.handle(lifecycle, c)
	}
	s.wg.Wait()
	for _, p := range s.profiles {
		if p.local != nil {
			p.local.Close()
		}
		if p.full != nil {
			p.full.Close()
		}
		if p.runtime != nil {
			p.runtime.Close()
		}
	}
	return acceptErr
}
