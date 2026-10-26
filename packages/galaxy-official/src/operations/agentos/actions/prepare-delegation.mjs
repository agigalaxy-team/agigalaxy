import { z } from 'zod';
import { workbenchAiPromptReviewSchema } from "../action-catalog.mjs";
import { fail, parse, label, requiredActionFor } from './support.mjs';

export async function prepareAiPrompt({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  if (this.authority.acceptsDuty?.(actor))
    fail('operations_agentos_management_card_requires_human', 403);
  const item = await this.service(
      'permissions',
      'delegatedPrompt',
    ).delegatedPrompt(actor, { aiAccountId: x.aiAccountId }),
    prompt = item.prompt;
  expiry(item.readExpiresAt);
  if (prompt.text === x.prompt) fail('operations_ai_prompt_no_change');
  const command = {
    aiAccountId: x.aiAccountId,
    expectedRevision: prompt.revision,
    expectedPromptVersion: prompt.promptVersion,
    prompt: x.prompt,
    delegationVersion: item.delegationVersion,
  };
  const target = {
    kind: 'ai-work-prompt',
    id: x.aiAccountId,
    label: label(prompt.name, '获准 AI') + '的岗位工作要求',
    href:
      '/admin/operations/ai-work-accounts?domain=' +
      prompt.domain +
      '&tab=duty',
  };
  const title = '修改「' + label(prompt.name, '获准 AI') + '」的岗位工作要求';
  const requiredAction = 'ai.prompts.update';
  const review = workbenchAiPromptReviewSchema.parse({
    kind: 'ai-work-prompt',
    aiAccountId: x.aiAccountId,
    domain: prompt.domain,
    name: prompt.name,
    configId: prompt.configId,
    expectedRevision: prompt.revision,
    promptVersion: prompt.promptVersion,
    nextPromptVersion: prompt.promptVersion + 1,
    scope: 'role-work-requirements',
    source: prompt.text ? 'saved-configuration' : 'empty-default',
    before: prompt.text,
    after: x.prompt,
    effect: 'new-rounds-only',
  });
  basis = [
    {
      label: '当前岗位要求',
      value: '版本 ' + prompt.promptVersion + '；配置修订 ' + prompt.revision,
    },
    { label: '人工管理范围', value: '委派版本 ' + item.delegationVersion },
  ];
  impact = [
    '仅更新这个岗位的工作要求，新轮次采用新版本。',
    '模型、固定代码边界、目标、角色权限、自动授权、开关和运行频率保持原配置。',
  ];
  return { target, title, requiredAction, command, review, impact, basis };
}

export async function prepareAiRole({ actor, x, operationId, expiry }) {
  let impact = [],
    basis = [];
  if (this.authority.acceptsDuty?.(actor))
    fail('operations_agentos_management_card_requires_human', 403);
  const permissions = this.service('permissions', 'delegatedRolePreparation'),
    directory = await permissions.delegatedDirectory(actor),
    item = await permissions.delegatedRolePreparation(actor, x.command),
    role = x.command;
  expiry(directory.readExpiresAt);
  expiry(item.readExpiresAt);
  if (directory.delegation?.version !== item.delegationVersion)
    fail('operations_ai_delegation_version_changed');
  const command = {
    command: item.command,
    delegationVersion: item.delegationVersion,
  };
  const requiredAction = requiredActionFor(x);
  const assignment = role.kind === 'assignment-save',
    selectedId = assignment
      ? (role.id ?? parse(z.uuid(), operationId))
      : role.kind === 'role-update'
        ? role.id
        : parse(z.uuid(), operationId),
    name = assignment
      ? directory.targetAiAccounts.find((row) => row.id === role.aiAccountId)
          ?.name
      : role.name;
  const target = {
    kind: assignment ? 'ai-role-assignment' : 'ai-role',
    id: selectedId,
    label: label(name, '获准 AI 专用角色'),
    href: '/admin/operations/permissions?tab=roles',
  };
  const title = assignment
    ? (role.enabled ? '分配' : '撤回') + '获准 AI 的专用角色'
    : role.kind === 'role-create'
      ? '创建获准 AI 专用角色'
      : '修改获准 AI 专用角色';
  basis = [
    { label: '人工管理范围', value: '委派版本 ' + item.delegationVersion },
    { label: '原对象版本', value: String(role.expectedVersion) },
  ];
  impact = assignment
    ? [
        '只' +
          (role.enabled ? '分配' : '撤回') +
          '这个获准其他 AI 的指定专用角色。',
        '目标 AI：' +
          label(name, '获准 AI') +
          '；角色：' +
          label(
            directory.roles.find((row) => row.id === role.roleId)?.name,
            '当前专用角色',
          ),
      ]
    : [
        '角色名称：' + role.name,
        '角色说明：' + role.description,
        '角色状态：' + (role.enabled ? '启用' : '停用'),
        '角色权限：' + (role.permissions.join('、') || '无'),
        '管理目标：' +
          role.targetAiAccountIds
            .map((id) =>
              label(
                directory.targetAiAccounts.find((row) => row.id === id)?.name,
                '获准 AI',
              ),
            )
            .join('、'),
      ];
  impact.push(
    '只影响人工委派内其他 AI 的专用角色；共享角色、人员角色、总控自身与管理范围保持原边界。',
  );
  return { target, title, requiredAction, command, impact, basis };
}
