import type {FactReference} from './presentation-types';
export const attemptStates:Record<string,string>={running:'正在尝试',completed:'尝试已结束',inconclusive:'暂无结论',canceled:'已取消',abandoned:'已停止'};
export const refsKey = (x: FactReference) => `${x.id}:${x.version}`;
export const split = (s: string) =>
  s
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);
export const names: Record<string,string> = {
  diagnosis: '诊断',
  advice: '建议',
  'context-addition': '补充背景',
  'tool-introduction': '引入工具',
  patch: '补丁',
  review: '复核',
  takeover: '接管',
  verification: '验证',
  'scope-clarification': '范围澄清',
  'multi-node-collaboration': '多节点协作',
};
export const outcomes: Record<string,string> = {
  succeeded: '达到所述结果',
  partial: '部分达到',
  failed: '未达到',
  inconclusive: '尚不明确',
  conflicting: '存在冲突',
};
export const methods: Record<string,string> = {
  'participant-feedback': '参与者反馈',
  'requester-acceptance': '请求者接受反馈',
  'local-test': '实际本地测试',
  'unit-test': '单元测试',
  'integration-test': '集成测试',
  build: '构建',
  'ci-report': 'CI报告',
  'peer-review': '同行复核',
  'human-review': '人工评审',
  'production-validation': '实际生产验证',
};
export const receiptMessages: Record<string, string> = {
  acknowledged: '上次提交已收到。正文仍按当前阅读权限打开。',
  absent: '尚未查到上次提交。原内容仍保留。',
  conflict: '上次提交的接收记录不一致，已停止继续发送。',
  none: '本机没有待确认的提交。',
  'result-unknown': '正在确认上次提交，原内容仍保留。',
};
export const actionTitles:Record<string,string>={'attempt-start':'开始一次尝试','attempt-end':'这次尝试怎么样了','attempt-correct':'更正尝试记录',intervention:'写下做了什么','intervention-response':'回应这条工作记录','result-recorded':'补充结果',evidence:'添加来源',verification:'记录检查',deliver:'交给发起者', 'resolution-recorded':'说明解决情况',revoke:'撤回记录'};
export const observationNames:Record<string,string>={current:'当前版本',superseded:'已有更正',revoked:'已撤回',unavailable:'当前不可读',unknown:'尚不明确',available:'当时可用',unreachable:'当时无法访问',removed:'已移除',passed:'所列检查通过',failed:'所列检查未通过',inconclusive:'尚无定论',comment:'反馈',accepted:'接受','partially-accepted':'部分接受',rejected:'不接受'};
export function downloadRecord(value:unknown,name='galaxy-work-record.json'){
  const blob=new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
