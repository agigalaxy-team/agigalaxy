package operationsrules

import (
	"context"
	"sync"
	"time"
)

// StartOptions receives only the policies and consumers already constructed by
// the owning process. Loading a second configuration is deliberately absent.
type StartOptions struct {
	Rules                 *Service
	Component, InstanceID string
	Baselines             map[string]Object
	Consumers             []PolicyConsumer
	OnRefreshFailure      func(error)
}
type Lifecycle struct {
	Service *Service
	Runtime *PolicyRuntime
	cancel  context.CancelFunc
	done    chan struct{}
	once    sync.Once
}

// Start preserves the original API/Worker bootstrap, initial adoption and
// thirty-second refresh. API alone initializes the P14 editing heads.
func Start(ctx context.Context, o StartOptions) (*Lifecycle, error) {
	if !has([]string{"api", "worker"}, o.Component) || o.Rules == nil {
		return nil, fail("operations_policy_consumers_invalid", 400)
	}
	if e := o.Rules.Bootstrap(ctx, o.Baselines); e != nil {
		return nil, e
	}
	if o.Component == "api" {
		if e := o.Rules.Initialize(ctx); e != nil {
			return nil, e
		}
	}
	runtime, e := NewPolicyRuntime(o.Rules, o.Component, o.InstanceID, o.Consumers)
	if e != nil {
		return nil, e
	}
	if _, e = runtime.Refresh(ctx); e != nil {
		return nil, e
	}
	work, cancel := context.WithCancel(ctx)
	l := &Lifecycle{Service: o.Rules, Runtime: runtime, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(l.done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-work.Done():
				return
			case <-ticker.C:
				result, e := runtime.Refresh(work)
				if e == nil {
					for _, v := range list(result["items"]) {
						if obj(v)["errorCode"] != nil {
							e = fail("operations_policy_apply_failed", 503)
							break
						}
					}
				}
				if e != nil && work.Err() == nil && o.OnRefreshFailure != nil {
					o.OnRefreshFailure(e)
				}
			}
		}
	}()
	return l, nil
}
func (l *Lifecycle) Stop() {
	if l == nil {
		return
	}
	l.once.Do(l.cancel)
	<-l.done
}
