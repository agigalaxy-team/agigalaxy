import type { ModuleEntry } from '../adapter-types.ts';

const MODULE_LABELS: Record<string, string> = {
  'galaxy-id': '银河 ID 与本地身份卡',
  'case-workspace': '工作中的 Case 与本地历史',
  'consent-controls': '隐私、披露与授权记录',
  'agent-mcp': 'Agent / MCP 接入',
  'agent-guidance': 'AI 引导与初始化支持',
};

export function divider() {
  return '────────────────────────────────────────';
}

// The stable OpenCode Dialog can soft-wrap mixed CJK/Latin text without
// reserving a full second row. These intentional short lines avoid overlap.
export function localBoundary(language = 'zh-CN') {
  return language === 'en-US'
    ? 'Local only · no remote account · no sync\nNo public Proof · no Worker / Hub'
    : '仅本机运行 · 无远程账户 · 无同步\n无公开 Proof · 无 Worker / Hub';
}

export function formatModules(
  modules: (string | ModuleEntry)[] = [],
  catalog: ModuleEntry[] = [],
  language = 'zh-CN',
) {
  const catalogById = new Map(catalog.map((module) => [module.id, module]));
  return modules
    .map((module) => {
      const id = typeof module === 'string' ? module : module.id;
      const title =
        (language === 'zh-CN' ? MODULE_LABELS[id] : null) ??
        (typeof module === 'string' ? undefined : module.title) ??
        catalogById.get(id)?.title ??
        id;
      return `• ${title}`;
    })
    .join('\n');
}

// Only recognized conditions get specific guidance; unknown failures use the
// calling page's plain-language fallback rather than exposing internal output.
export function humanizeOperationError(error: unknown, language: string, fallback: string) {
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } : null;
  const code = typeof value?.code === 'string' ? value.code : '';
  const message = typeof value?.message === 'string' ? value.message : typeof error === 'string' ? error : '';
  const detail = code + ' ' + message;
  const chinese = language !== 'en-US';
  if (/native_handover_legacy_unsupported|native_handover_legacy_connection/.test(detail))
    return chinese
      ? '旧版服务需要手动切换。完成当前工作后，退出并重新启动银河服务。'
      : 'The older service requires a manual switch. Finish the current work, then stop and restart the Galaxy service.';
  if (value?.status === 403 || value?.statusCode === 403 || /(?:^|\D)403(?:\D|$)|forbidden|access_denied|insufficient_scope/i.test(detail))
    return chinese
      ? '服务拒绝了这次操作。请检查权限或联系服务管理员。'
      : 'The service refused this operation. Check your permissions or contact the service administrator.';
  return fallback;
}
