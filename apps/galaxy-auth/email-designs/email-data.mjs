/** Visual candidates only. Password login is unchanged; these are email-code actions. */
export const EMAIL_DESIGNS = Object.freeze([
  {id: 'a', name: '品牌简洁', description: '横排品牌、左对齐正文，验证码一眼可见。', file: 'a-brand.html', theme: 'galaxy-mail-brand', selected: false, historical: true},
  {id: 'b', name: '精细账笺', description: '编辑式标题、细线分区与侧注，安静而有秩序。', file: 'b-editorial.html', theme: 'galaxy-mail-editorial', selected: true, historical: false},
  {id: 'c', name: '柔和服务', description: '居中阅读、柔和留白，适合日常账户通知。', file: 'c-service.html', theme: 'galaxy-mail-service', selected: false, historical: true},
]);

export const EMAIL_SCENARIOS = Object.freeze([
  {
    id: 'register', name: '注册邮箱验证', purpose: '注册账户',
    subject: '验证你的 AGI Galaxy 邮箱', title: '验证你的邮箱',
    preheader: '输入验证码，完成 AGI Galaxy 账户的邮箱验证。',
    introduction: '你正在注册 AGI Galaxy 账户。',
    instruction: '请回到注册页面，输入下方验证码。',
    continuation: '验证后，继续完成账户注册。',
  },
  {
    id: 'reset-password', name: '找回密码', purpose: '重设密码',
    subject: '重设 AGI Galaxy 密码的验证码', title: '重设你的密码',
    preheader: '在找回密码页面输入验证码，继续设置新密码。',
    introduction: '你正在为 AGI Galaxy 账户找回密码。',
    instruction: '请回到找回密码页面，输入下方验证码。',
    continuation: '验证后，设置新的登录密码。',
  },
  {
    id: 'change-email', name: '邮箱变更', purpose: '确认新邮箱',
    subject: '确认你的 AGI Galaxy 新邮箱', title: '确认新的邮箱地址',
    preheader: '输入验证码，确认使用这个邮箱。',
    introduction: '你正在更改 AGI Galaxy 账户的邮箱。',
    instruction: '请回到邮箱变更页面，输入下方验证码。',
    continuation: '验证后，继续完成邮箱变更。',
  },
  {
    id: 'system', name: '系统通知', kind: 'notice', designs: ['b'], purpose: '系统通知',
    subject: 'AGI Galaxy 系统通知', title: '账户资料管理',
    preheader: '在账户中心管理资料与使用设置。',
    paragraphs: ['你可以在账户中心管理个人资料与使用设置。', '公开资料与私有内容分别设置，按自己的需要选择。'],
    note: '',
  },
  {
    id: 'service', name: '服务通知', kind: 'notice', designs: ['b'], purpose: '服务通知',
    subject: 'AGI Galaxy 服务说明', title: '隐私与资料范围',
    preheader: '上传资料与对外公开分别设置。',
    paragraphs: ['上传资料与对外公开是两项独立的选择。', '你可以在相关设置中查看当前资料范围，按需要调整。'],
    note: '',
  },
]);

export const SENDER_NAME_CHOICES = Object.freeze([
  {value: 'AGI Galaxy', recommended: true, description: '简洁统一，推荐用于全部账户事务邮件。'},
  {value: 'AGI Galaxy 账户', recommended: false, description: '明确账户用途，适合与其他品牌邮件区分。'},
  {value: 'AGI Galaxy 支持', recommended: false, description: '适合服务通知；名称不表示人工在线。'},
]);

// Deliberately fixed synthetic values. This module never accepts or stores a
// real verification code. The actual expiry belongs to the authentication flow.
export const EMAIL_PREVIEW = Object.freeze({code: '482913', expiresInMinutes: 10, label: '预览示例'});
