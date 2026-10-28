package information

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func watchInvalid() error { return fault.New("invalid_information_watch", 400) }
func parsePlan(v any) (Object, error) {
	p := obj(v)
	if !exact(p, []string{"purpose", "sources", "expiresAt"}, []string{"report"}) || !integer(p["expiresAt"], 1, maxSafe) {
		return nil, watchInvalid()
	}
	purpose, ok := purpose(p["purpose"])
	if !ok {
		return nil, watchInvalid()
	}
	sources, e := parseSelections(p["sources"], 4)
	if e != nil {
		return nil, watchInvalid()
	}
	report := Object{"mode": "changes"}
	if value, present := p["report"]; present {
		r := obj(value)
		if r["mode"] == "changes" {
			if !exact(r, []string{"mode"}, nil) {
				return nil, watchInvalid()
			}
		} else if r["mode"] == "daily" {
			if !exact(r, []string{"mode", "utcMinute"}, nil) || !integer(r["utcMinute"], 0, 1439) {
				return nil, watchInvalid()
			}
			report["utcMinute"] = r["utcMinute"]
		} else {
			return nil, watchInvalid()
		}
		report["mode"] = r["mode"]
	}
	return Object{"purpose": purpose, "sources": sources, "expiresAt": p["expiresAt"], "report": report}, nil
}
func parseWatch(raw []byte, kind string) (Object, error) {
	var o Object
	if protocol.Decode(raw, &o) != nil || o == nil {
		return nil, watchInvalid()
	}
	switch kind {
	case "command", "stop":
		if !one(o["action"], "start", "revise", "pause", "resume", "end") || !uuidPattern.MatchString(text(o, "operationId")) || !uuidPattern.MatchString(text(o, "watchId")) || !integer(o["expectedRevision"], 0, maxSafe) {
			return nil, watchInvalid()
		}
		keys := []string{"operationId", "watchId", "expectedRevision", "action"}
		if one(o["action"], "start", "revise") {
			keys = append(keys, "plan")
		}
		if !exact(o, keys, nil) {
			return nil, watchInvalid()
		}
		if o["plan"] != nil {
			plan, e := parsePlan(o["plan"])
			if e != nil {
				return nil, e
			}
			o["plan"] = plan
		} else if one(o["action"], "start", "revise") {
			return nil, watchInvalid()
		}
	case "receipt":
		if !exact(o, []string{"operationId", "requestHash"}, nil) || !uuidPattern.MatchString(text(o, "operationId")) || !hashPattern.MatchString(text(o, "requestHash")) {
			return nil, watchInvalid()
		}
	case "check":
		if !exact(o, []string{"watchId", "expectedRevision"}, nil) || !uuidPattern.MatchString(text(o, "watchId")) || !integer(o["expectedRevision"], 1, maxSafe) {
			return nil, watchInvalid()
		}
	case "list", "events":
		if !exact(o, nil, []string{"activeOnly", "watchId", "after", "limit"}) {
			return nil, watchInvalid()
		}
		if v, present := o["activeOnly"]; present {
			if _, ok := v.(bool); !ok {
				return nil, watchInvalid()
			}
		} else {
			o["activeOnly"] = false
		}
		for _, k := range []string{"watchId", "after"} {
			if v, present := o[k]; present {
				s, ok := v.(string)
				if !ok || !uuidPattern.MatchString(s) {
					return nil, watchInvalid()
				}
			}
		}
		if v, present := o["limit"]; present {
			if !integer(v, 1, 20) {
				return nil, watchInvalid()
			}
		} else {
			o["limit"] = int64(10)
		}
	}
	return o, nil
}
