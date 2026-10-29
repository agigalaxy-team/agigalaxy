package operationsqueries

import "testing"

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
