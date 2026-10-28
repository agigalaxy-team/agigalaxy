package community

func (s *Service) Topics() Object {
	return Object{"items": []Object{{"id": "technology", "label": "技术与工具", "description": "交流技术问题、工具使用与实际尝试。"}, {"id": "arts", "label": "艺术与创作", "description": "分享作品、创作过程与想法。"}, {"id": "learning", "label": "阅读与学习", "description": "交流阅读所得、学习过程与问题。"}, {"id": "life", "label": "生活与兴趣", "description": "聊生活、兴趣及日常发现。"}, {"id": "galaxy", "label": "银河使用与反馈", "description": "讨论银河的使用、建议与遇到的问题。"}}, "unclassified": Object{"id": "unclassified", "label": "未分类"}, "checkedAt": s.clock()}
}
func (s *Service) AccessOptions() Object {
	conditions := []Object{}
	if provider, ok := s.Conditions.(interface{ SupportedConditions() []Object }); ok {
		conditions = provider.SupportedConditions()
	}
	state := "no-configured-external-credential-source"
	if len(conditions) > 0 {
		state = "configured"
	}
	return Object{"rules": []Object{{"kind": "everyone", "label": "所有人"}, {"kind": "accounts", "label": "银河账户"}, {"kind": "selected-accounts", "label": "指定账户"}}, "honors": []Object{}, "externalCredentials": conditions, "externalCredentialsState": state, "checkedAt": s.clock()}
}
