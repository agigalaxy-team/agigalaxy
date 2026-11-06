package discovery

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func (w *Worker) deliverFeedbackState(ctx context.Context) (Object, error) {
	r := w.Runtime
	if r.Gorse == nil {
		return Object{"state": "not-connected", "target": "gorse-feedback-state"}, nil
	}
	claim, e := r.Store.claimFeedbackState(ctx)
	if e != nil {
		return nil, e
	}
	if claim == nil {
		return Object{"state": "idle"}, nil
	}
	defer claim.release()
	effective := claim.FeedbackState
	if effective.Active {
		// Cancellation remains possible after the source is withdrawn. A new
		// positive feedback must still refer to currently discoverable content.
		reference := ItemReference(claim.ItemKey)
		if reference == nil {
			e = invalid()
		} else {
			var current *Document
			current, e = r.Source.Load(ctx, *reference)
			if e == nil && current == nil {
				effective.Active = false
			}
		}
	}
	if e == nil {
		e = r.Gorse.SyncFeedback(ctx, effective)
	}
	var code *string
	if e != nil {
		value := fault.Code(e)
		if value == "internal_error" {
			value = "discovery_delivery_failed"
		}
		code = &value
	}
	bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	settled, e := r.Store.completeFeedbackState(bounded, claim, code)
	if e != nil {
		return nil, e
	}
	state := "delivered"
	if !settled {
		state = "source-changed"
	} else if code != nil {
		state = "failed"
	}
	result := Object{"state": state, "target": "gorse-feedback-state"}
	if code != nil {
		result["code"] = *code
	}
	return result, nil
}
