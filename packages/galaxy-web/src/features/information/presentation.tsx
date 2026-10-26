import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";

import { informationField, informationText as readable } from "./state";
import type { InformationSelection, InformationScope, InformationItem, HonorRule } from "./state";

export const sourceNames: Record<string, string> = {
  history: '工作经历',
  capsule: '方法',
  proof: '验证记录',
  task: '求助',
  opportunity: '项目与交流',
  honor: '荣誉依据',
};
export const stateNames: Record<string, string> = {
  active: '关注中',
  paused: '已暂停',
  ended: '已结束',
  expired: '已到期',
};
export const actionNames: Record<string, string> = {
  start: '开启关注',
  revise: '保存关注范围',
  pause: '暂停关注',
  resume: '恢复关注',
  end: '结束关注',
};
export const time = (value: unknown) =>
  (typeof value === 'number'||typeof value === 'string')&&value
    ? new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString(
        'zh-CN',
      )
    : '尚无记录';
export const ruleKey = (rule: HonorRule) =>
  (rule.id ?? rule.ruleId) + '@' + (rule.version ?? rule.ruleVersion);
export const sourceType = (source: InformationSelection['source']) =>
  source?.kind === 'honor'
    ? 'honor'
    : source?.kind === 'reference'
      ? source.request.search.type
      : source?.request?.type;
export const scopeTitle = (selection: InformationSelection) => {
  const source = selection.source,
    type = sourceType(source);
  return source?.kind === 'reference'
    ? '所选' + (sourceNames[type] ?? '资料')
    : source?.kind === 'honor'
      ? '所选荣誉的适用依据'
      : (sourceNames[type] ?? '所选资料');
};
export function itemLink(item: InformationItem) {
  const r = item.record,
    type = item.type ?? item.recordKind,
    id =
      type === 'capsule' ? (informationField(r,'capsuleId') ?? informationField(r,'id') ?? item.ref.id) : item.ref.id;
  if (typeof id !== 'string' || !id) return null;
  if (type === 'task') return '/app/tasks/' + encodeURIComponent(id);
  if (type === 'capsule')
    return (
      '/app/capsules/' +
      encodeURIComponent(id) +
      (typeof informationField(r,'versionId')==='string' ? '/versions/' + encodeURIComponent(String(informationField(r,'versionId'))) : '')
    );
  return null;
}
export function exactSelection(scope: InformationScope, item: InformationItem):InformationSelection {
  return {
    key: scope.key,
    source:
      scope.source.kind === 'honor'
        ? scope.source
        : {
            kind: 'reference',
            request: {
              search:
                scope.source.kind === 'reference'
                  ? scope.source.request.search
                  : scope.source.request,
              ref: item.ref,
            },
          },
  };
}
export function download(value: unknown, name = 'galaxy-source.json') {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    ),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function FactSummary({ item, full = false }: { item: InformationItem; full?: boolean }) {
  const r = item.record ?? {},
    fact = informationField(r,'record') ?? r,
    request = informationField(r,'request');
  const body = [
    item.summary,
    informationField(fact,'summary'),
    informationField(request,'summary'),
    informationField(fact,'description'),
    informationField(fact,'strategy'),
    informationField(request,'expectedOutcome'),
  ]
    .map(readable)
    .find(Boolean);
  const pairs: [string,unknown][] = [
    ['做过的事', informationField(fact,'description') ?? informationField(fact,'strategy')],
    [
      '观察到的结果',
      informationField(fact,'observedEffect') ?? informationField(informationField(fact,'outcome'),'summary') ?? informationField(informationField(fact,'resolution'),'summary'),
    ],
    ['适用范围', informationField(r,'applicableScope') ?? informationField(informationField(r,'rule'),'scope') ?? informationField(request,'expectedOutcome')],
    ['适用限制', informationField(fact,'limitations')],
    ['使用环境', informationField(fact,'environment') ?? informationField(informationField(fact,'conditions'),'environment')],
  ];
  const sections=pairs
    .map(([label, value]) => ({
      label,
      text: readable(value),
    }))
    .filter((value) => value.text && value.text !== body);
  return (
    <div className="information-body">
      {body && (
        <p className={full ? 'reading-prose' : 'information-excerpt'}>{body}</p>
      )}
      {full &&
        sections.map((value) => (
          <section key={value.label}>
            <h4>{value.label}</h4>
            <p className="reading-prose">{value.text}</p>
          </section>
        ))}
      {full && (
        <ReadingDetails className="information-source-details">
          <ReadingSummary>来源与版本</ReadingSummary>
          <dl>
            <dt>类型</dt>
            <dd>{sourceNames[item.type ?? item.recordKind ?? ''] ?? '工作资料'}</dd>
            {(informationField(fact,'at') ?? informationField(fact,'createdAt') ?? informationField(r,'createdAt'))!=null && (
              <>
                <dt>记录时间</dt>
                <dd>{time(informationField(fact,'at') ?? informationField(fact,'createdAt') ?? informationField(r,'createdAt'))}</dd>
              </>
            )}
            {item.sourceVersion != null && (
              <>
                <dt>来源版本</dt>
                <dd>{String(item.sourceVersion)}</dd>
              </>
            )}
            {item.ref?.id && (
              <>
                <dt>原记录</dt>
                <dd>{item.ref.id}</dd>
              </>
            )}
          </dl>
          <button className="text-action" onClick={() => download(item)}>
            保存完整来源文件
          </button>
        </ReadingDetails>
      )}
    </div>
  );
}
