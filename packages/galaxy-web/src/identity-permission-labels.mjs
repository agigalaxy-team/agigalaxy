export const identityPermissionGroups = [
  {title:'交流与工作',items:[['binding','连接当前服务'],['consent','使用本人选定的数据范围'],['case-teaser','记录工作过程与结果'],['assistance','发起和参与求助'],['context','使用共享资料'],['notifications','读取提醒']]},
  {title:'经历与资料',items:[['evidence','管理来源与检查'],['proof','保存及分享证明'],['history','读取本人经历'],['capsules','使用和分享方法'],['data-export','导出本人资料']]},
  {title:'专业功能',items:[['moderation','在已有权限内处理内容'],['builders','管理建设者资料'],['audit','查看有权读取的处理记录']]},
  {title:'身份与数据控制',items:[['manage-identity','管理设备及恢复设置'],['data-delete','申请删除本人资料']]},
];

export const identityPermissionLabel = value => value === '*'
  ? '全部已声明的设备权限'
  : identityPermissionGroups.flatMap(group => group.items).find(item => item[0] === value)?.[1] ?? value;
