package operationsstrategies

import (
	"encoding/json"
	"os"
	"testing"
)

func TestAgentP13FixtureMatchesOwningParser(t *testing.T) {
	data, err := os.ReadFile("../../../services/galaxy-operations-agentos/tests/fixtures/p13_configuration.json")
	if err != nil {
		t.Fatal(err)
	}
	var configuration Object
	if err = json.Unmarshal(data, &configuration); err != nil {
		t.Fatal(err)
	}
	if _, err = ParseConfiguration(configuration); err != nil {
		t.Fatalf("owning parser rejected model-facing fixture: %v", err)
	}
}
