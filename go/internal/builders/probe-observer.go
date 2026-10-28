package builders

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	"github.com/google/uuid"
	"time"
)

type ProbeTransport struct {
	Get  func(context.Context, string, int, time.Duration) ([]byte, error)
	Post func(context.Context, string, []byte, int, time.Duration) ([]byte, error)
}

// ObserveEndpoint sends only a fresh unrelated GetTask ID to the exact public
// interface selected in the Node's existing probe request. It never sends work.
func ObserveEndpoint(ctx context.Context, target Object, now func() time.Time, transport ProbeTransport) (Object, error) {
	if target["protocol"] != "a2a/1.0" || target["transport"] != "JSONRPC" || !publicfetch.ValidURL(txt(target, "endpoint")) || !publicfetch.ValidURL(txt(target, "cardUrl")) {
		return nil, errors.New("A2A probe target required")
	}
	if _, ok := target["tenant"].(string); !ok {
		return nil, errors.New("A2A probe tenant required")
	}
	if now == nil {
		now = time.Now
	}
	if transport.Get == nil {
		transport.Get = publicfetch.GetA2ACard
	}
	if transport.Post == nil {
		transport.Post = publicfetch.PostA2A
	}
	start := time.Now()
	checked := now().Unix()
	stage := "card"
	cardRetrieved, responded, authentication := false, false, false
	var reachable any
	hash := ""
	finish := func(status, reason string) Object {
		v := Object{"version": 1, "status": status, "reason": reason, "checkedAt": checked, "validUntil": checked + 300, "durationMs": time.Since(start).Round(time.Millisecond).Milliseconds(), "stage": stage, "cardRetrieved": cardRetrieved, "endpointReachable": reachable, "protocolResponded": responded, "authenticationRequired": authentication, "authority": "registry-worker-public-observation", "endpointControlVerified": false, "capabilityVerified": false}
		if hash != "" {
			v["cardHash"] = hash
		}
		return v
	}
	fail := func(e error) Object {
		var rejected *publicfetch.A2ARejected
		if errors.As(e, &rejected) {
			authentication = true
		}
		if authentication {
			return finish("authentication-required", stage+"-authentication-required")
		}
		if reachable == true {
			return finish("protocol-mismatch", "invalid-rpc-response")
		}
		if stage == "rpc" {
			reachable = false
		}
		return finish("unavailable", "public-read-unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, e := transport.Get(ctx, txt(target, "cardUrl"), 65536, 5*time.Second)
	if e != nil {
		return fail(e), nil
	}
	cardRetrieved = true
	document, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return fail(e), nil
	}
	wire, e := protocol.EncodeJS(document)
	if e != nil {
		return fail(e), nil
	}
	hash = identity.Digest(wire)
	card := obj(document)
	interfaces := card["supportedInterfaces"]
	if interfaces == nil {
		interfaces = card["supported_interfaces"]
	}
	selected := false
	for _, v := range arr(interfaces) {
		item := obj(v)
		version := item["protocolVersion"]
		if version == nil {
			version = item["protocol_version"]
		}
		binding := item["protocolBinding"]
		if binding == nil {
			binding = item["protocol_binding"]
		}
		tenant := item["tenant"]
		if tenant == nil {
			tenant = ""
		}
		selected = selected || item["url"] == target["endpoint"] && tenant == target["tenant"] && version == "1.0" && binding == "JSONRPC"
	}
	if !selected {
		return finish("protocol-mismatch", "selected-interface-not-advertised"), nil
	}
	stage = "rpc"
	id := uuid.NewString()
	request := ordered("jsonrpc", "2.0", "id", 1, "method", "GetTask", "params", ordered("id", id, "historyLength", 0, "tenant", target["tenant"]))
	body, e := protocol.EncodeJS(request)
	if e != nil {
		return nil, e
	}
	raw, e = transport.Post(ctx, txt(target, "endpoint"), body, 65536, 5*time.Second)
	if e != nil {
		var rejected *publicfetch.A2ARejected
		if errors.As(e, &rejected) {
			reachable = true
		}
		return fail(e), nil
	}
	reachable = true
	reply, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return fail(e), nil
	}
	rpc := obj(reply)
	if rpc["jsonrpc"] != "2.0" || num(rpc, "id") != 1 {
		return fail(errors.New("invalid RPC envelope")), nil
	}
	if failure := obj(rpc["error"]); failure != nil {
		if _, ok := failure["message"].(string); !ok {
			return fail(errors.New("invalid RPC error")), nil
		}
		responded = true
		if num(failure, "code") == -32001 {
			return finish("reachable", "task-not-found-response"), nil
		}
		return finish("protocol-mismatch", "other-a2a-error"), nil
	}
	result := obj(rpc["result"])
	if result["id"] != id {
		return finish("protocol-mismatch", "unexpected-task-response"), nil
	}
	responded = true
	return finish("reachable", "task-read-response"), nil
}
