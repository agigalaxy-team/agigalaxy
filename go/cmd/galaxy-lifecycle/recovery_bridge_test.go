package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRecoveryBridgeExposesLedgerColumnsWithoutDatabase(t *testing.T) {
	var out bytes.Buffer
	if err := recoveryBridge(context.Background(), strings.NewReader("{\"mode\":\"ledger-columns\"}\n"), &out); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Result map[string][]string `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Result) != 3 || len(got.Result["deletion_requests"]) == 0 || len(got.Result["deletion_events"]) == 0 || len(got.Result["deletion_executions"]) == 0 {
		t.Fatal("missing deletion capture contract")
	}
}
func TestRecoveryBridgeRejectsNetworkAndUnboundTargets(t *testing.T) {
	for _, dir := range []string{"", "localhost:5432", "/tmp/sockets/business", "../sockets/business"} {
		if err := privateSocket(dir, "11111111-1111-4111-8111-111111111111"); err == nil {
			t.Fatalf("accepted non-clone target %q", dir)
		}
	}
	var out bytes.Buffer
	if err := recoveryBridge(context.Background(), strings.NewReader("{\"mode\":\"source\",\"socketDirectory\":\"localhost:5432\",\"database\":\"galaxy_pilot\",\"user\":\"postgres\"}\n"), &out); err == nil {
		t.Fatal("accepted network target")
	}
	if out.Len() != 0 {
		t.Fatal("invalid target produced a result")
	}
}
