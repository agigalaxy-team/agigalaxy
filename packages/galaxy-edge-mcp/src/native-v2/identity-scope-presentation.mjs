// Display only: these groups do not add, remove or approve any permission.
const groups = [
 {title:'交流与工作',items:[['binding','连接当前服务'],['consent','使用本人选定的数据范围'],['case-teaser','记录工作过程与结果'],['assistance','发起和参与求助'],['context','使用共享资料'],['notifications','读取提醒']]},
 {title:'经历与资料',items:[['evidence','管理来源与检查'],['proof','保存及分享证明'],['history','读取本人经历'],['capsules','使用和分享方法'],['data-export','导出本人资料']]},
 {title:'专业功能',items:[['moderation','在已有权限内处理内容'],['builders','管理建设者资料'],['audit','查看有权读取的处理记录']]},
 {title:'身份与数据控制',items:[['manage-identity','管理设备及恢复设置'],['data-delete','申请删除本人资料']]},
];

export function nativeIdentityScopeGroups(scopes) {
 const requested = new Set(scopes), known = new Set(groups.flatMap(group => group.items.map(([key]) => key)));
 const result = groups.map(group => ({title:group.title,items:group.items.filter(([key]) => requested.has(key)).map(([key,label]) => ({key,label}))})).filter(group => group.items.length);
 const other = [...requested].filter(key => !known.has(key)).map(key => ({key,label:key === '*' ? '全部已声明的设备权限' : '其他权限：'+key}));
 if (other.length) result.push({title:'其他范围',items:other});
 return result;
}
