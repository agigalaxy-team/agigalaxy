package actions

func messageDraftResult(kind string, result Object, operation string, request, command Object, receipt bool) (Object, error) {
	create := kind == "message-draft-create"
	id := request["targetId"]
	version, revision := num(command["expectedVersion"])+1, num(command["expectedRevision"])+1
	if create {
		id = command["planId"]
		version, revision = 1, 1
	}
	plan := obj(result["plan"])
	if plan["id"] != id || plan["state"] != "draft" || num(plan["version"]) != version || num(plan["revision"]) != revision || !same(plan["config"], command["config"]) {
		if receipt {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return Object{"operationId": operation, "state": "unknown", "summary": "消息草稿保存结果暂未核实，系统会继续查询原操作。", "receipt": nil}, nil
	}
	summary := "消息草稿已保存，事实与受众仍待人工核实。"
	if create {
		summary = "消息草稿已生成，事实与受众仍待人工核实。"
	}
	return Object{"operationId": operation, "state": "completed", "summary": summary, "receipt": Object{"operationId": operation, "planId": id, "version": plan["version"], "revision": plan["revision"], "state": "draft", "automation": Object{"kind": "human-required", "factsConfirmed": false}, "replayed": result["replayed"] == true}}, nil
}
