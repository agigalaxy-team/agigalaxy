package operationsqueries

import (
	"regexp"
	"strconv"
	"time"
	_ "time/tzdata"
)

var analyticsBucketInstant = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)

func analyticsTimeFacts(basis, data Object) Object {
	var sourceTimezone any
	zone := str(object(basis["timezone"])["name"])
	if zone != "" && zone != "Local" {
		if _, err := time.LoadLocation(zone); err == nil {
			sourceTimezone = zone
		}
	}
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	point := func(value any) (any, any, string) {
		s, ok := value.(string)
		if !ok || s == "" {
			return nil, nil, "missing-source-time"
		}
		if instant, err := time.Parse(time.RFC3339Nano, s); err == nil && shanghai != nil {
			return s, instant.In(shanghai).Format(time.RFC3339Nano), "source-instants"
		}
		for _, layout := range []string{"2006-01-02", "2006-01-02T15:04:05", "2006-01-02T15:04:05.999999999"} {
			if _, err := time.Parse(layout, s); err == nil {
				return s, nil, "missing-offset"
			}
		}
		return nil, nil, "invalid-source-time"
	}
	from, displayFrom, fromReason := point(basis["from"])
	to, displayTo, toReason := point(basis["to"])
	state, reason := "available", "source-instants"
	if displayFrom == nil || displayTo == nil {
		state = "partial"
		if displayFrom == nil && displayTo == nil {
			state = "unknown"
		}
		for _, candidate := range []string{"invalid-source-time", "missing-source-time", "missing-offset"} {
			if fromReason == candidate || toReason == candidate {
				reason = candidate
				break
			}
		}
	}
	calendar, seen, complete := []any{}, map[string]bool{}, true
	if series, ok := data["series"].([]any); ok {
		for _, raw := range series {
			sourceDate := str(object(raw)["date"])
			date, kind := sourceDate, "source-calendar-bucket"
			if analyticsBucketInstant.MatchString(sourceDate) {
				validOffset := true
				if sourceDate[len(sourceDate)-1] != 'Z' {
					offset := sourceDate[len(sourceDate)-6:]
					hours, _ := strconv.Atoi(offset[1:3])
					minutes, _ := strconv.Atoi(offset[4:6])
					validOffset = hours <= 23 && minutes <= 59
				}
				if _, err := time.Parse(time.RFC3339Nano, sourceDate); err != nil || !validOffset {
					complete = false
					continue
				}
				date, kind = sourceDate[:10], "source-date-label"
			}
			parsed, err := time.Parse("2006-01-02", date)
			if err != nil || parsed.Format("2006-01-02") != date {
				complete = false
				continue
			}
			if seen[date] {
				continue
			}
			seen[date] = true
			weekday := int(parsed.Weekday())
			if weekday == 0 {
				weekday = 7
			}
			names := []string{"星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"}
			calendar = append(calendar, Object{"sourceDate": sourceDate, "date": date, "weekday": weekday, "weekdayZh": names[weekday-1], "kind": kind, "timezone": sourceTimezone})
		}
	}
	return Object{"schemaVersion": 1, "scope": "response-basis-not-all-metric-windows", "displayTimezone": "Asia/Shanghai", "window": Object{"sourceFrom": from, "sourceTo": to, "sourceTimezone": sourceTimezone, "displayFrom": displayFrom, "displayTo": displayTo, "state": state, "reason": reason}, "calendar": calendar, "calendarComplete": complete}
}
