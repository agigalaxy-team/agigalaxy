package operationsqueries

func maintenanceProjection(x Object) Object {
	availability := shape("state code", "s")
	out := object(project(x, Object{"components": []any{merge(shape("id label processState processBasis health healthBasis checkedAt processCheckedAt healthCheckedAt code", "s"), Object{"processAvailability": availability, "healthAvailability": availability})}, "storage": []any{merge(shape("id kind observedAt", "s"), Object{"availability": availability}, shape("capacityBytes availableBytes usedBytes physicalReclaimedBytes", "n"))}, "queues": merge(shape("scope", "s"), Object{"includesAllPlatformQueues": "b", "availability": availability, "items": []any{Object{"name": "s", "counts": shape("created retry active completed cancelled failed", "n")}}}), "errors": merge(shape("window scope", "s"), Object{"availability": availability, "includesAllComponents": "b", "count": "n"}), "maintenanceMode": merge(shape("state source", "s"), Object{"businessWritesAccepted": "b", "revision": "n"}), "nativeAvailability": availability}))
	items, ok := out["components"].([]any)
	var sourceTotal any
	if original, ok := x["components"].([]any); ok {
		sourceTotal = len(original)
	}
	if !ok {
		out["componentSummary"] = Object{"basis": "returned-component-list", "available": false, "total": nil, "sourceTotal": nil, "complete": false, "processByState": nil, "healthByBasis": nil}
		return out
	}
	process := Object{"running": 0, "stopped": 0, "failed": 0, "not-applicable": 0, "unknown": 0}
	groups := map[string]Object{}
	order := []string{}
	for _, v := range items {
		r := object(v)
		state := str(r["processState"])
		if object(r["processAvailability"])["state"] != "available" || oneOf(state, "running", "stopped", "failed", "not-applicable", "unknown") == nil {
			state = "unknown"
		}
		n, _ := number(process[state])
		process[state] = n + 1
		basis := str(r["healthBasis"])
		if oneOf(basis, "container-healthcheck", "native-health-endpoint", "prometheus-target", "prometheus-probe", "not-connected") == nil {
			basis = "other-or-unavailable"
		}
		group := groups[basis]
		if group == nil {
			group = Object{"basis": basis, "total": 0, "healthy": 0, "unhealthy": 0, "unknown": 0, "available": 0, "notConfigured": 0, "unavailable": 0}
			groups[basis] = group
			order = append(order, basis)
		}
		availability := object(r["healthAvailability"])["state"]
		category := "unavailable"
		if availability == "available" {
			category = "available"
		} else if availability == "not-configured" {
			category = "notConfigured"
		}
		health := "unknown"
		if availability == "available" && (r["health"] == "healthy" || r["health"] == "unhealthy") {
			health = str(r["health"])
		}
		for _, key := range []string{"total", category, health} {
			n, _ := number(group[key])
			group[key] = n + 1
		}
	}
	health := []any{}
	for _, key := range order {
		health = append(health, groups[key])
	}
	out["componentSummary"] = Object{"basis": "returned-component-list", "available": true, "total": len(items), "sourceTotal": sourceTotal, "complete": sourceTotal == len(items), "processByState": process, "healthByBasis": health}
	return out
}
