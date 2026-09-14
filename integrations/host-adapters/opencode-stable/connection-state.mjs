const discovery = {
  'not-read': ['已配置；尚未读取或连接', 'Configured; not read or connected'],
  reading: ['正在读取服务信息', 'Reading service information'],
  verified: ['服务信息签名有效；不代表已连接', 'Service information verified; not a connection'],
  expired: ['服务信息已过期；请重新读取', 'Service information expired; read again'],
  unreachable: ['未取得服务响应；检查网络与端点后重试', 'No service response; check network and endpoint'],
  unverified: ['服务信息未通过验证；检查信任配置', 'Service information unverified; check trust configuration'],
  unsupported: ['服务未声明支持绑定和会话', 'Service does not advertise binding and sessions'],
  'configuration-invalid': ['本机宿主配置不完整或无效', 'Local host configuration is incomplete or invalid'],
  canceled: ['读取已取消；可重新读取', 'Read canceled; you may read again'],
  closed: ['宿主入口已关闭', 'Host entry closed'],
};
const session = {
  'no-session': ['没有本机会话', 'No local session'],
  'session-local': ['本机会话可用；远端状态未核查', 'Local session available; remote status not checked'],
  expired: ['本机会话已过期；请重新预览连接', 'Local session expired; preview a new connection'],
  disconnected: ['本机会话已断开；不代表远端绑定已撤销', 'Local session disconnected; remote binding not revoked'],
  'local-authorization-changed': ['本机身份或授权已变化；旧会话已失效', 'Local identity or authorization changed; old session invalidated'],
  'local-check-failed': ['本机配置或信任检查失败；旧会话已失效', 'Local configuration or trust check failed; old session invalidated'],
  'remote-outcome-unknown': ['远端结果未知；旧会话已失效，请核查后重连', 'Remote outcome unknown; old session invalidated; check before reconnecting'],
  'remote-rejected': ['远端拒绝当前会话；可能已撤销或失效', 'Remote rejected this session; it may be revoked or invalid'],
  'local-reset': ['本机已重置；旧会话已失效', 'Local reset; old session invalidated'],
  'binding-verified': ['本次核查确认绑定有效；不代表持续在线', 'Binding verified for this check; not continuous availability'],
  superseded: ['本次查询已被新操作替代', 'This check was superseded'],
};
export function describeConnectionState(state, language = 'zh-CN', kind = 'session') {
  const table = kind === 'discovery' ? discovery : session;
  const copy = Object.hasOwn(table, state) ? table[state] : ['状态未确认', 'Status unconfirmed'];
  return copy[language === 'en-US' ? 1 : 0];
}
