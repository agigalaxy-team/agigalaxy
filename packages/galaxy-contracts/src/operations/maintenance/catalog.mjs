// The maintenance surface accepts catalog identifiers, never shell commands,
// repository URLs, database names or paths supplied by a browser or model.
export const maintenanceModules = Object.freeze([
 {id:'business',label:'业务内容',kind:'authoritative',required:true},
 {id:'accounts',label:'账户身份',kind:'authoritative',required:true},
 {id:'chat',label:'私聊服务',kind:'authoritative',required:true},
 {id:'objects',label:'文件与对象仓库',kind:'authoritative',required:true},
 {id:'website',label:'站点与内容发布',kind:'authoritative',required:true},
 {id:'analytics',label:'使用分析',kind:'authoritative',required:true},
 {id:'recommendation',label:'推荐策略与反馈',kind:'authoritative',required:true},
 {id:'search',label:'搜索索引',kind:'derived',required:true},
 {id:'agentos',label:'AI运行与人工续行',kind:'authoritative',required:true},
 {id:'messaging',label:'消息计划与投递账本',kind:'authoritative',required:true},
 {id:'configuration',label:'配置与运行版本',kind:'authoritative',required:true},
]);
export const maintenanceModuleIds=Object.freeze(maintenanceModules.map(x=>x.id));
export const maintenanceComponents=Object.freeze([
 ['api','业务API'],['worker','业务Worker'],['publisher','内容发布'],['admin','运营后台'],['website','前台站点'],
 ['business-db','业务数据库集群'],['accounts-db','账户数据库集群'],['keycloak','账户身份'],['chat','私聊'],
 ['objects','对象仓库'],['scanner','附件扫描'],['prometheus','指标采集'],['loki','运行日志'],['grafana','监控面板'],['log-collector','日志收集'],
 ['analytics-api','分析API'],['analytics-worker','分析Worker'],['analytics-db','分析数据库'],['analytics-cache','分析队列缓存'],['analytics-events','分析事件存储'],
 ['recommendation','推荐引擎'],['recommendation-db','推荐数据库'],['recommendation-cache','推荐队列缓存'],['search','搜索引擎'],['agentos','AI运行服务'],['model-gateway','统一模型入口'],
].map(([id,label])=>Object.freeze({id,label})));
export const maintenanceOpeningConditions=Object.freeze([
 'capture-integrity','database-consistency','authorization-invalidated',
 'source-lifecycle-reconciled','outbound-delivery-reconciled',
 'required-modules-ready','public-readiness',
]);
export const maintenanceAuditActions=Object.freeze([
 'maintenance-query','maintenance-logs-query','maintenance-backup-create',
 'maintenance-backup-verify','maintenance-restore-plan','maintenance-restore-approve',
 'maintenance-restore-execute','maintenance-restore-cancel',
]);
export const maintenanceActionPermissions=Object.freeze({
 'maintenance-query':'maintenance.read',
 'maintenance-logs-query':'maintenance.logs.read',
 'maintenance-backup-create':'maintenance.backups.create',
 'maintenance-backup-verify':'maintenance.backups.verify',
 'maintenance-restore-plan':'maintenance.restore.plan',
 'maintenance-restore-approve':'maintenance.restore.approve',
 'maintenance-restore-execute':'maintenance.restore.execute',
 'maintenance-restore-cancel':'maintenance.restore.plan',
});
export const maintenancePlanStates=Object.freeze([
 'blocked','awaiting-approval','approved','preparing','restoring','validating',
 'ready-to-open','opening','completed','failed','cancelled',
]);
export const maintenanceDiagnostics=Object.freeze([
 'connection_failure','permission_denied','memory_pressure','storage_full',
 'tls_event','database_migration','backup_event','authentication_event',
 'scanner_event','service_shutdown','service_lifecycle','failure',
]);
