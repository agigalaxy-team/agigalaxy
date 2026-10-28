package native

import (
	"context"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func TestA2aOriginalUTF16SliceRetainedAcrossJournalAndMCPText(t *testing.T) {
	value := strings.Repeat("x", 159) + "😀tail"
	original := initializationNode(t, `const s=process.argv[1].slice(0,160);console.log(JSON.stringify({json:JSON.stringify({slice:s})}));`, value)
	slice := a2aSlice(value, 160)
	wire, e := protocol.Encode(map[string]any{"slice": slice})
	if e != nil || string(wire) != original["json"] {
		t.Fatal("original lone UTF-16 unit changed", string(wire), original, e)
	}
	store, _ := NewStore(t.TempDir(), "https://official.invalid")
	j, _ := newA2aJournal(store, a2aJournalScope{"actor", "https://official.invalid", "https://peer.invalid/a2a", "", "selected"})
	row, e := j.change(context.Background(), "id", 0, nil, func(map[string]any) (map[string]any, error) {
		return map[string]any{"id": "id", "caseId": "case", "attemptId": "attempt", "slice": slice, "ordinary": "\\ud800 literal " + "\u2028"}, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	_, e = j.change(context.Background(), "id", a2aInteger(row["revision"]), nil, func(previous map[string]any) (map[string]any, error) {
		next := a2aClone(previous)
		next["status"] = "observed"
		return next, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	got, e := j.get(context.Background(), "id")
	if e != nil {
		t.Fatal(e)
	}
	wire, e = protocol.Encode(map[string]any{"slice": got["slice"]})
	if e != nil || string(wire) != original["json"] || text(got["ordinary"]) != "\\ud800 literal "+"\u2028" {
		t.Fatal("journal replaced exact UTF-16 display value", string(wire), e)
	}
	result, e := toolResult(map[string]any{"slice": got["slice"]})
	if e != nil {
		t.Fatal(e)
	}
	wire, e = protocol.Encode(result)
	if e != nil || !strings.Contains(string(wire), `\\ud83d`) {
		t.Fatal("MCP text lost original JSON surrogate", string(wire), e)
	}
}
