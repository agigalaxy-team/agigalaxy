package native

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func TestA2aOriginalSDKExactRPCAndExplicitPeerTrust(t *testing.T) {
	original := initializationNode(t, `import {createRequire} from 'node:module';import {sdkPeer} from './packages/galaxy-a2a/test/sdk-peer.mjs';const require=createRequire(new URL('./packages/galaxy-a2a/package.json',import.meta.url)),{AgentCard,SendMessageRequest}=require('@a2a-js/sdk'),{ClientFactory,JsonRpcTransportFactory}=require('@a2a-js/sdk/client');const peer=await sdkPeer();let bodyJson,responseJson;try{const client=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:async(input,init)=>{const r=new Request(input,init);bodyJson=await r.text();const result=await peer.post(r.url,{bodyJson,credential:'synthetic-peer-token',signal:r.signal});responseJson=JSON.stringify(result);return new Response(responseJson,{headers:{'Content-Type':'application/json'}})}})],preferredTransports:['JSONRPC']}).createFromAgentCard(AgentCard.fromJSON(peer.card));await client.sendMessage(SendMessageRequest.fromJSON({tenant:'fixture',message:{messageId:'00000000-0000-4000-8000-000000000001',role:'ROLE_USER',parts:[{text:'work',mediaType:'text/plain'}]},configuration:{acceptedOutputModes:['text/plain','application/json'],historyLength:0,returnImmediately:true}}));console.log(JSON.stringify({bodyJson,responseJson,cardJson:JSON.stringify(peer.card)}))}finally{await peer.close()}`)
	wire, e := protocol.DecodeOrdered([]byte(text(original["bodyJson"])))
	if e != nil {
		t.Fatal(e)
	}
	params := a2aObject(wire)["params"]
	calls := 0
	post := func(ctx context.Context, endpoint string, raw []byte, credential string) ([]byte, error) {
		calls++
		if endpoint != "https://peer.example.org/a2a" || credential != "synthetic-peer-token" || string(raw) != original["bodyJson"] {
			t.Fatal("original SDK envelope differs", string(raw), original["bodyJson"])
		}
		return []byte(text(original["responseJson"])), nil
	}
	result, e := a2aRPC(context.Background(), post, "https://peer.example.org/a2a", "synthetic-peer-token", "SendMessage", params)
	if e != nil || text(a2aObject(result)["id"]) == "" || calls != 1 {
		t.Fatal(result, e, calls)
	}
	cardJSON := text(original["cardJson"])
	hash := a2aHash([]byte(cardJSON))
	raw := `{"peers":[{"id":"peer","endpoint":"https://peer.example.org/a2a","tenant":"fixture","peerPrincipal":"selected-principal","agentCard":` + cardJSON + `,"cardHash":"` + hash + `","trustExpiresAt":2000000000000,"authentication":{"mode":"bearer-environment","variable":"GALAXY_A2A_PEER_SELECTED_TOKEN"}}]}`
	peers, e := a2aConfiguration([]byte(raw))
	if e != nil || len(peers) != 1 {
		t.Fatal(peers, e)
	}
	lookups := 0
	env := func(key string) (string, bool) {
		lookups++
		if key != "GALAXY_A2A_PEER_SELECTED_TOKEN" {
			t.Fatal("ambient credential lookup", key)
		}
		return "synthetic-peer-token", true
	}
	credential, e := peers[0].authorize(time.UnixMilli(1999999999999), env)
	if e != nil || credential != "synthetic-peer-token" || lookups != 1 {
		t.Fatal(credential, e, lookups)
	}
	if _, e = peers[0].authorize(time.UnixMilli(2000000000000), env); e == nil || lookups != 1 {
		t.Fatal("expired trust read credential", e, lookups)
	}
	modified := peers[0]
	modified.cardHash = strings.Repeat("0", 64)
	if _, e = modified.authorize(time.UnixMilli(1), env); e == nil || lookups != 1 {
		t.Fatal("untrusted card used external credential", e)
	}
	if _, e = a2aConfiguration([]byte(strings.Replace(raw, `"peerPrincipal"`, `"unknownField":"value","peerPrincipal"`, 1))); e == nil {
		t.Fatal("unknown config accepted")
	}
	for _, address := range []string{"http://127.0.0.1/a2a", "https://127.0.0.1/a2a", "https://peer.local/a2a", "https://peer.example.org/a2a?secret=1"} {
		if _, e = a2aPostPublic(context.Background(), address, []byte(`{}`), ""); e == nil {
			t.Fatal("unsafe production endpoint accepted", address)
		}
	}
}

func TestA2aOriginalPeerScopeWHATWGNormalization(t *testing.T) {
	inputs := []string{"https://PEER.example.org:443", "https://peer.example.org/a/%2e%2e/a2a", "https://例子.example/a2a", "https://[2606:4700:4700::1111]:443/a2a"}
	encoded, _ := protocol.Encode(inputs)
	original := initializationNode(t, `console.log(JSON.stringify({values:JSON.parse(process.argv[1]).map(x=>new URL(x).href)}));`, string(encoded))
	for i, input := range inputs {
		peer := a2aPeer{endpoint: input}
		if got := peer.scope("actor", "https://official.invalid").Endpoint; got != uploadRows(original["values"])[i] {
			t.Fatal("peer scope URI differs from original URL", input, got, original)
		}
	}
}
