// Management admission is separate from business role definitions. These
// actions also require preconfigured root or current promoted administrator
// eligibility; directory reads and ordinary business actions remain distinct.
export const managementMaintainerPermissionCodes=Object.freeze([
  'management.accounts.create',
  'management.accounts.profile.write',
  'management.accounts.login.disable',
  'management.accounts.login.restore',
  'management.accounts.password.reset',
  'management.accounts.sessions.revoke',
  'management.accounts.delete',
  'permissions.assignments.write',
]);
const actions=new Set(managementMaintainerPermissionCodes);
export const requiresManagementMaintainer=code=>actions.has(code);
