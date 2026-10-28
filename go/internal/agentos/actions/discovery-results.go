package actions

func discoveryResult(kind string, result Object, operationID string, x, command Object, receipt bool) (Object, error) {
	if kind != "recommendation-direction" {
		safe := safeReceipt(result)
		state, summary := "completed", "本次处理已完成。"
		switch safe["phase"] {
		case "applied":
			summary = "搜索配置已生效。"
		case "failed":
			state, summary = "failed", "搜索配置未生效。"
		case "result-unknown":
			state, summary = "unknown", "搜索配置结果暂未取得，正在查询原操作。"
		case "prepared", "submitting", "task-pending":
			state, summary = "processing", "搜索配置正在应用。"
		}
		return Object{"operationId": operationID, "state": state, "summary": summary, "receipt": safe}, nil
	}
	if result["operationId"] == operationID && result["state"] == "unknown" && result["receipt"] == nil {
		return unknownRecommendation(operationID), nil
	}
	expected := []any{}
	selected := false
	for _, v := range items(command["beforeDirections"]) {
		row := obj(v)
		direction := row["direction"]
		if row["key"] == command["themeKey"] {
			direction = command["direction"]
			selected = true
		}
		expected = append(expected, Object{"key": row["key"], "direction": direction})
	}
	if !selected {
		expected = append(expected, Object{"key": command["themeKey"], "direction": command["direction"]})
	}
	policy := obj(result["policy"])
	if result["operationId"] != operationID || num(policy["version"]) != num(command["expectedVersion"])+1 || policy["enabled"] != command["enabled"] || !same(policy["controls"], command["controls"]) || !same(policy["directions"], expected) {
		if receipt {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return unknownRecommendation(operationID), nil
	}
	summary := "这次主题推荐方向已保存，方向调控仍未启用。"
	if policy["enabled"] == true {
		summary = "这次主题推荐方向已保存。"
	}
	return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": Object{"operationId": operationID, "version": policy["version"], "themeKey": command["themeKey"], "direction": command["direction"], "enabled": policy["enabled"], "replayed": result["replayed"] == true}}, nil
}
