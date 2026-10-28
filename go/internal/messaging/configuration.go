package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
)

func normalizeConfig(input any) (Object, error) {
	config := obj(clone(input))
	if config == nil || !keys(config, "channels", "content", "audience", "senderKey", "automation", "schedule") || !required(config, "channels", "content", "audience", "schedule") {
		return nil, invalidInput()
	}
	channels := arr(config["channels"])
	if len(channels) < 1 || len(channels) > 3 {
		return nil, invalidInput()
	}
	seen := map[string]bool{}
	for _, value := range channels {
		key := str(value)
		if !contains([]string{"announcement", "inapp", "email"}, key) || seen[key] {
			return nil, invalidInput()
		}
		seen[key] = true
	}
	content := obj(config["content"])
	if content == nil || !keys(content, "purpose", "title", "body", "href", "expiresAt") || !required(content, "purpose", "title", "body", "expiresAt") || !contains([]string{"maintenance", "service-update", "community-update"}, str(content["purpose"])) {
		return nil, invalidInput()
	}
	for key, max := range map[string]int{"title": 160, "body": 8000} {
		value, ok := textValue(content[key], max)
		if !ok {
			return nil, invalidInput()
		}
		content[key] = value
	}
	if href, exists := content["href"]; !exists || href == nil {
		content["href"] = nil
	} else {
		value, ok := href.(string)
		if !ok || len([]rune(value)) > 2048 || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.Contains(value, `\`) || regexp.MustCompile(`^/(?:api|v1|v2|admin)(?:/|$)`).MatchString(value) {
			return nil, invalidInput()
		}
		for _, r := range value {
			if unicode.IsSpace(r) || unicode.IsControl(r) {
				return nil, invalidInput()
			}
		}
	}
	if _, e := date(content["expiresAt"]); e != nil {
		return nil, invalidInput()
	}
	audience := obj(config["audience"])
	switch str(audience["kind"]) {
	case "all-accounts":
		if !keys(audience, "kind") {
			return nil, invalidInput()
		}
	case "accounts":
		values := arr(audience["accountIds"])
		if !keys(audience, "kind", "accountIds") || len(values) < 1 || len(values) > 500 {
			return nil, invalidInput()
		}
		seen := map[string]bool{}
		for _, value := range values {
			if !uuidOK(value) || seen[str(value)] {
				return nil, invalidInput()
			}
			seen[str(value)] = true
		}
	case "attributes":
		values := arr(audience["subjectTypes"])
		if !keys(audience, "kind", "subjectTypes") || len(values) < 1 || len(values) > 3 {
			return nil, invalidInput()
		}
		seen := map[string]bool{}
		for _, value := range values {
			key := str(value)
			if !contains([]string{"person", "agent", "organization"}, key) || seen[key] {
				return nil, invalidInput()
			}
			seen[key] = true
		}
	default:
		return nil, invalidInput()
	}
	if key, exists := config["senderKey"]; !exists {
		config["senderKey"] = "notice"
	} else if _, ok := OfficialMailIdentities[str(key)]; !ok {
		return nil, invalidInput()
	}
	if value, exists := config["automation"]; exists {
		automation := obj(value)
		confirmed, ok := automation["factsConfirmed"].(bool)
		kind := str(automation["kind"])
		if automation == nil || !keys(automation, "kind", "factsConfirmed") || !ok || !contains([]string{"human-required", "ordinary"}, kind) || kind == "ordinary" && !confirmed {
			return nil, invalidInput()
		}
	}
	schedule := obj(config["schedule"])
	switch str(schedule["kind"]) {
	case "immediate":
		if !keys(schedule, "kind") {
			return nil, invalidInput()
		}
	case "once":
		if !keys(schedule, "kind", "at") {
			return nil, invalidInput()
		}
		if _, e := date(schedule["at"]); e != nil {
			return nil, invalidInput()
		}
	case "recurring":
		if !keys(schedule, "kind", "cron", "timezone") {
			return nil, invalidInput()
		}
		cron, ok := textValue(schedule["cron"], 160)
		zone := str(schedule["timezone"])
		if !ok || zone == "" || len(zone) > 100 {
			return nil, invalidInput()
		}
		if _, e := time.LoadLocation(zone); e != nil {
			return nil, invalidInput()
		}
		schedule["cron"] = cron
	default:
		return nil, invalidInput()
	}
	return config, nil
}
func (s *Service) validateConfig(ctx context.Context, tx pgx.Tx, config Object, activating bool) error {
	content := obj(config["content"])
	expires, e := date(content["expiresAt"])
	if e != nil {
		return invalidInput()
	}
	if !expires.After(s.now()) {
		return failure("operations_messaging_expired")
	}
	schedule := obj(config["schedule"])
	switch str(schedule["kind"]) {
	case "once":
		at, _ := date(schedule["at"])
		if !at.Before(expires) || activating && !at.After(s.now()) {
			return failure("operations_messaging_schedule_invalid", 400)
		}
	case "recurring":
		if s.Scheduler == nil {
			return failure("operations_messaging_scheduler_unavailable", 503)
		}
		items, e := s.Scheduler.PreviewSchedule(ctx, str(schedule["cron"]), str(schedule["timezone"]), s.now(), 1)
		if e != nil {
			var known *fault.Error
			if errors.As(e, &known) {
				return e
			}
			return failure("operations_messaging_schedule_invalid", 400)
		}
		if len(items) == 0 || !items[0].Before(expires) {
			return failure("operations_messaging_schedule_invalid", 400)
		}
	}
	audience := obj(config["audience"])
	if str(audience["kind"]) == "accounts" {
		var n int
		if e := tx.QueryRow(ctx, "SELECT count(*) FROM community_accounts WHERE endpoint=$1 AND id=ANY($2::uuid[])", s.Endpoint, list(audience["accountIds"])).Scan(&n); e != nil {
			return e
		}
		if n != len(arr(audience["accountIds"])) {
			return failure("operations_messaging_audience_unavailable")
		}
	}
	return nil
}
