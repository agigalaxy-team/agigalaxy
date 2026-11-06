package opportunities

import "testing"

func TestParticipantMatchingUsesReadableCluesWithoutInventingKind(t *testing.T) {
	candidate := Object{"kind": "unknown", "displayName": "连接诊断", "summary": "排查数据库连接失败", "functions": []string{"postgresql"}}
	reasons, ok := participantMatch(candidate, "数据库连接故障", nil, nil)
	if !ok || len(reasons) == 0 {
		t.Fatal("expected lexical candidate", reasons)
	}
	if _, ok = participantMatch(candidate, "数据库连接故障", nil, []string{"person"}); ok {
		t.Fatal("unknown participant was classified as a person")
	}
	if _, ok = participantMatch(candidate, "数据库连接故障", []string{"rust"}, nil); ok {
		t.Fatal("function filter was ignored")
	}
}
func TestParticipantOptionsRejectUnknownFieldsAndInvalidTypes(t *testing.T) {
	if _, e := participantOptions(Object{"query": "协作", "types": []any{"person"}, "limit": 3}); e != nil {
		t.Fatal(e)
	}
	if _, e := participantOptions(Object{"query": "协作", "types": []any{"verified-expert"}}); e == nil {
		t.Fatal("invented classification accepted")
	}
	if _, e := participantOptions(Object{"query": "协作", "projectId": "irrelevant"}); e == nil {
		t.Fatal("unexpected input accepted")
	}
}
