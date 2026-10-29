package operationsqueries

import (
	"encoding/json"
	"testing"
)

func TestAnalyticsTimeFactsPreserveSourceBucketsAndOffsets(t *testing.T) {
	basis := Object{"from": "2026-10-25T11:44:00Z", "to": "2026-10-26T11:44:00Z", "timezone": Object{"name": "UTC", "source": "native-clickhouse-default"}}
	data := Object{"series": []any{Object{"date": "2026-10-25", "unique_visitors": 42}, Object{"date": "2026-10-25", "unique_visitors": 2}}}
	facts := analyticsTimeFacts(basis, data)
	window := object(facts["window"])
	if window["displayFrom"] != "2026-10-25T19:44:00+08:00" || window["sourceTimezone"] != "UTC" || window["state"] != "available" {
		t.Fatalf("window: %v", window)
	}
	calendar := anyArray(facts["calendar"])
	if len(calendar) != 1 || object(calendar[0])["weekday"] != 7 || object(calendar[0])["weekdayZh"] != "星期日" || object(calendar[0])["timezone"] != "UTC" {
		t.Fatalf("source calendar: %v", calendar)
	}
	if object(anyArray(data["series"])[0])["date"] != "2026-10-25" || object(anyArray(data["series"])[0])["unique_visitors"] != 42 || basis["from"] != "2026-10-25T11:44:00Z" {
		t.Fatal("source was modified")
	}
	missingZone := analyticsTimeFacts(Object{"from": "2026-10-25T11:44:00Z", "to": "2026-10-26T11:44:00Z"}, nil)
	if object(missingZone["window"])["displayFrom"] != "2026-10-25T19:44:00+08:00" || object(missingZone["window"])["sourceTimezone"] != nil {
		t.Fatal("explicit offset depends on missing bucket zone")
	}
	unknown := analyticsTimeFacts(Object{"from": "2026-10-25", "to": "2026-10-26T11:44:00"}, Object{"series": []any{Object{"date": "2026-10-99"}}})
	if object(unknown["window"])["reason"] != "missing-offset" || object(unknown["window"])["displayFrom"] != nil || unknown["calendarComplete"] != false {
		t.Fatal("missing offset or invalid bucket was guessed")
	}
}

func TestAnalyticsTimeFactsISODateLabelsKeepSourceCalendar(t *testing.T) {
	basis := Object{"from": "2026-10-22T11:44:38Z", "to": "2026-10-29T11:44:38Z"}
	data := Object{"series": []any{
		Object{"date": "2026-10-25T00:00:00.000Z", "unique_visitors": 390},
		Object{"date": "2026-10-26T23:30:00-05:00", "unique_visitors": 26},
		Object{"date": "2026-10-27", "unique_visitors": 44},
	}}
	facts := analyticsTimeFacts(basis, data)
	items := anyArray(facts["calendar"])
	if facts["calendarComplete"] != true || len(items) != 3 {
		t.Fatalf("calendar: %v", facts)
	}
	first, second, third := object(items[0]), object(items[1]), object(items[2])
	if first["sourceDate"] != "2026-10-25T00:00:00.000Z" || first["date"] != "2026-10-25" || first["weekday"] != 7 || first["weekdayZh"] != "星期日" || first["kind"] != "source-date-label" || first["timezone"] != nil {
		t.Fatalf("ISO source label: %v", first)
	}
	if second["sourceDate"] != "2026-10-26T23:30:00-05:00" || second["date"] != "2026-10-26" || second["weekdayZh"] != "星期一" || second["kind"] != "source-date-label" {
		t.Fatalf("offset crossed Shanghai date: %v", second)
	}
	if third["sourceDate"] != "2026-10-27" || third["date"] != "2026-10-27" || third["kind"] != "source-calendar-bucket" {
		t.Fatalf("date-only: %v", third)
	}
	if object(anyArray(data["series"])[0])["date"] != "2026-10-25T00:00:00.000Z" || object(anyArray(data["series"])[0])["unique_visitors"] != 390 {
		t.Fatal("source data modified")
	}
	fixture, err := json.Marshal(Object{"tool": "query-operations", "module": "analytics", "view": "overview", "availability": "available", "data": Object{"kind": "overview", "data": data, "basis": basis, "timeFacts": facts}, "pagination": Object{"next": nil, "complete": true}, "evidenceRefs": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("SDK_FIXTURE=%s", fixture)
	for _, invalid := range []string{"2026-10-25T00:00:00", "2026-10-25T00:00:00+24:00", "2026-10-25T00:00:00+08:60", "2026-02-30T00:00:00Z"} {
		got := analyticsTimeFacts(basis, Object{"series": []any{Object{"date": invalid}}})
		if got["calendarComplete"] != false || len(anyArray(got["calendar"])) != 0 {
			t.Fatalf("invalid %q guessed: %v", invalid, got)
		}
	}
}
