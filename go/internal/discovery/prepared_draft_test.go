package discovery

import "testing"

func TestPreparedSearchDraftBindsSelectedDraft(t *testing.T) {
	command := Object{"operationId": "11111111-1111-4111-8111-111111111111", "expectedRevision": 2, "reason": "save", "settings": Object{"synonyms": []any{}, "rankingMode": "relevance", "fixedConstraints": fixedConstraints}, "expectedDraftId": nil}
	if _, err := ParseSearchCommand("prepared-draft", command); err != nil {
		t.Fatal(err)
	}
	delete(command, "expectedDraftId")
	if _, err := ParseSearchCommand("prepared-draft", command); err == nil {
		t.Fatal("missing draft binding accepted")
	}
}
