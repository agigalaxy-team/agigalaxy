import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { configurationChoice } from './configuration-client.mjs';
const key = (x: any) => `${x.ref.kind}:${x.ref.id}:${x.ref.version}`;
export function ConfigurationPicker({
  runtime,
  subjectId,
  busy,
  run,
  selected,
  onChange,
  onlyOwn = false,
  single = false,
}: any) {
  const [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [versions, setVersions] = useState<any[]>([]),
    [versionNext, setVersionNext] = useState<number | null>(null),
    [objectId, setObjectId] = useState(''),
    [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setItems([]);
    setVersions([]);
    setLoaded(false);
    setNext(null);
    setObjectId('');
    return () => {
      generation.current++;
    };
  }, [runtime, subjectId]);
  async function call(path: string, input: any) {
    const token = generation.current,
      value = await runtime.api.call('/v2/configurations/' + path, input);
    if (token !== generation.current) throw Error('配置来源身份已变化。');
    return value;
  }
  async function load(after?: string) {
    const r = await call('query', {
      ...(onlyOwn ? { subjectId } : {}),
      limit: 20,
      ...(after ? { after } : {}),
    });
    setItems((old) => (after ? [...old, ...r.items] : r.items));
    setNext(r.nextAfter);
    setLoaded(true);
  }
  async function loadVersions(id: string, afterVersion = 0) {
    const r = await call('versions', { id, afterVersion, limit: 20 });
    setObjectId(id);
    setVersions((old) => (afterVersion ? [...old, ...r.items] : r.items));
    setVersionNext(r.nextAfterVersion);
  }
  const choose = (view: any, checked: boolean) => {
    const value = configurationChoice(view),
      rest = selected.filter((x: any) => key(x) !== key(value));
    onChange(checked ? [...(single ? [] : rest), value] : rest);
  };
  const available = [
    ...new Map(
      [...items, ...versions]
        .filter((x) => x.record && (!onlyOwn || x.subjectId === subjectId))
        .map((x) => [x.id + ':' + x.version, x]),
    ).values(),
  ];
  return (
    <details>
      <summary>
        {single
          ? '选取本次实际条件版本（可不选）'
          : '明确选择配置元数据作为内容来源（可选）'}
      </summary>
      <p>
        {single
          ? '只用于解释此次条件，不自动发布配置正文。未知时可以继续工作。'
          : '这里选择的是已登记的条件内容；引用它不会上传本地提示词或配置文件。其他作者内容另需复用许可。'}
      </p>
      <Button type="button" disabled={busy} onClick={() => run(() => load())}>
        读取可选配置
      </Button>
      {next && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(() => load(next))}
        >
          更多配置
        </Button>
      )}
      {loaded && !available.length && (
        <p>当前没有可读配置，可继续不带配置的协作。</p>
      )}
      {available.map((view: any) => {
        const value = configurationChoice(view);
        return (
          <article className="task-card" key={key(value)}>
            <label>
              <input
                type="checkbox"
                checked={selected.some((s: any) => key(s) === key(value))}
                onChange={(e) => choose(view, e.target.checked)}
              />
              {view.record.title} · v{view.version} ·{' '}
              {view.sourceStatus === 'historical-version'
                ? '历史条件'
                : '当前条件'}
            </label>
            <p>{view.record.summary}</p>
            <p>报告者：{view.subjectId}；安装状态未经银河核验</p>
            <Button
              type="button"
              disabled={busy}
              onClick={() => run(() => loadVersions(view.id))}
            >
              查看此对象的其他授权版本
            </Button>
          </article>
        );
      })}
      {versionNext && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(() => loadVersions(objectId, versionNext))}
        >
          更多历史版本
        </Button>
      )}
      {selected
        .filter((x: any) => x.ref.kind === 'configuration')
        .map((x: any) => (
          <p key={key(x)}>
            已明确选择 {x.label} v{x.ref.version}{' '}
            <button
              type="button"
              onClick={() =>
                onChange(selected.filter((s: any) => key(s) !== key(x)))
              }
            >
              移除
            </button>
          </p>
        ))}
    </details>
  );
}
