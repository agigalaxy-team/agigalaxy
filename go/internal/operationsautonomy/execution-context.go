package operationsautonomy

// The assignment describes durable intent. An execution owns only the work
// applicable to its activation; the scheduler owns later activations.
func executionContext(row, cfg Object) Object {
	trigger := obj(cfg["schedule"])
	id := row["config_id"]
	if dispatch := obj(cfg["dispatch"]); dispatch != nil {
		id, trigger = dispatch["id"], obj(dispatch["trigger"])
	} else if strategy := obj(cfg["strategyExecution"]); strategy != nil {
		trigger = obj(strategy["trigger"])
	}
	recurring := row["source"] != "workbench" && has([]string{"interval", "daily", "event"}, str(trigger["kind"]))
	goal := cfg["goal"]
	if recurring {
		goal = "执行交办在本次触发下适用的工作，完成本轮所需步骤并交付本轮结果。后续触发交由调度器，不属于本轮未完成工作。"
	}
	if work := str(cfg["executionGoal"]); work != "" {
		goal = work
	}
	return Object{
		"assignment": Object{"id": id, "objective": cfg["goal"], "recurring": recurring},
		"execution":  Object{"id": row["id"], "objective": goal, "dueAt": iso(row["due_at"]), "completionScope": "current-execution"},
		"scheduler":  Object{"owner": "server", "trigger": trigger, "futureActivations": "scheduler-owned"},
	}
}
