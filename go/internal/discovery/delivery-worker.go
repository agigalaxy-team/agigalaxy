package discovery

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"time"
)

func (w *Worker) DeliverOne(ctx context.Context) (Object, error) {
	r := w.Runtime
	claim, e := r.Store.ClaimDelivery(ctx)
	if e != nil {
		return nil, e
	}
	if claim == nil {
		return Object{"state": "idle"}, nil
	}
	settle := func(state string, code *string) error {
		bounded, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		return r.Store.CompleteDelivery(bounded, *claim, state, code)
	}
	if claim.Target == "openpanel" && r.OpenPanel == nil || claim.Target == "gorse" && r.Gorse == nil {
		code := "discovery_engine_not_connected"
		if e = settle("pending", &code); e != nil {
			return nil, e
		}
		return Object{"state": "not-connected"}, nil
	}
	event, e := r.Store.DeliveryEvent(ctx, *claim)
	if e != nil {
		return nil, e
	}
	if event == nil {
		if e = settle("excluded", nil); e != nil {
			return nil, e
		}
		return Object{"state": "excluded"}, nil
	}
	if content := object(event["content"]); content != nil {
		current, e := r.Source.Load(ctx, Reference{Kind: str(content, "kind"), ID: str(content, "id")})
		if e != nil {
			return w.deliveryFailure(*claim, settle, e)
		}
		if current == nil || current.Version != str(event, "sourceVersion") {
			if e = settle("excluded", nil); e != nil {
				return nil, e
			}
			return Object{"state": "source-unavailable"}, nil
		}
	}
	if claim.Target == "openpanel" && claim.SubmissionStarted {
		seen, e := r.OpenPanel.EventObserved(ctx, event)
		if e != nil {
			return w.deliveryFailure(*claim, settle, e)
		}
		state, code := "result-unknown", "discovery_delivery_unconfirmed"
		var failure *string = &code
		if seen {
			state = "delivered"
			failure = nil
		}
		if e = settle(state, failure); e != nil {
			return nil, e
		}
		result := "result-unknown"
		if seen {
			result = "confirmed"
		}
		return Object{"state": result}, nil
	}
	if claim.Target == "openpanel" {
		var started bool
		started, e = r.Store.BeginSubmission(ctx, *claim)
		if e != nil {
			return w.deliveryFailure(*claim, settle, e)
		}
		if !started {
			return Object{"state": "lease-lost"}, nil
		}
		e = r.OpenPanel.Track(ctx, event)
	} else {
		e = r.Gorse.Feedback(ctx, event)
	}
	if e != nil {
		return w.deliveryFailure(*claim, settle, e)
	}
	if e = settle("delivered", nil); e != nil {
		return nil, e
	}
	return Object{"state": "delivered", "target": claim.Target}, nil
}
func (w *Worker) deliveryFailure(claim DeliveryClaim, settle func(string, *string) error, cause error) (Object, error) {
	code := fault.Code(cause)
	if code == "internal_error" {
		code = "discovery_delivery_failed"
	}
	state := "pending"
	if claim.Target == "openpanel" && code != "discovery_engine_authorization_failed" {
		state = "result-unknown"
	}
	if e := settle(state, &code); e != nil {
		return nil, e
	}
	return Object{"state": "failed", "target": claim.Target, "code": code}, nil
}
