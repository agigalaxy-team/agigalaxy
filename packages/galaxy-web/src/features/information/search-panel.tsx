import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';

import { PageLoading } from "../../site-shell";

import { sourceNames, ruleKey } from "./presentation";
import type { InformationSessionModel } from "./use-information-session";
import { ResultScope } from "./results";

export function InformationSearchPanel({model}:{model:InformationSessionModel}) {
  const { client, query, setQuery, types, setTypes, windowKind, setWindowKind, environment, setEnvironment, functions, setFunctions, technologies, setTechnologies, searchLoading, page, setPage, honorOpen, setHonorOpen, rules, setRules, rule, setRule, honorSubject, setHonorSubject, busy, composeReady, inputId, visibleSubjects, person, draftProblem, run, search }=model;
  return (
        <>
          <form
            className="information-search"
            aria-busy={!composeReady}
            onSubmit={(event) => {
              event.preventDefault();
              void run(search);
            }}
          >
            <label htmlFor={inputId+'-query'}>
                    想查找什么？
              <div>
                <Input id={inputId+'-query'}
                  disabled={!composeReady}
                  maxLength={200}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="输入问题、方法或相关关键词"
                />
                <Button
                  type="submit"
                  disabled={busy || !client || !composeReady}
                >
                  <Search size={17} />
                  查找
                </Button>
              </div>
            </label>
            <div className="information-types">
              {Object.entries(sourceNames)
                .filter(([key]) => key !== 'honor')
                .map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      disabled={!composeReady}
                      checked={types.includes(key)}
                      onChange={(event) =>
                        setTypes((old) =>
                          event.target.checked
                            ? [...old, key]
                            : old.filter((value) => value !== key),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
            </div>
            <ReadingDetails mode="inline"
              className="information-filters"
              open={types.includes('opportunity') ? true : undefined}
            >
              <ReadingSummary>更多筛选</ReadingSummary>
              {types.includes('history') && (
                <>
                  <label>
                    经历时间
                    <select
                      value={windowKind}
                      onChange={(event) => setWindowKind(event.target.value)}
                    >
                      <option value="all-visible">全部可读经历</option>
                      <option value="90-days">最近 90 天</option>
                      <option value="365-days">最近一年</option>
                    </select>
                  </label>
                  <label htmlFor={inputId+'-environment'}>
                    使用环境
                    <Input id={inputId+'-environment'}
                      maxLength={160}
                      value={environment}
                      onChange={(event) => setEnvironment(event.target.value)}
                      placeholder="可选"
                    />
                  </label>
                </>
              )}
              {types.includes('opportunity') && (
                <>
                  <label htmlFor={inputId+'-functions'}>
                    想找的功能
                    <Input id={inputId+'-functions'}
                      value={functions}
                      onChange={(event) => setFunctions(event.target.value)}
                      placeholder="用逗号分隔"
                    />
                  </label>
                  <label htmlFor={inputId+'-technologies'}>
                    相关技术
                    <Input id={inputId+'-technologies'}
                      value={technologies}
                      onChange={(event) => setTechnologies(event.target.value)}
                      placeholder="可选，用逗号分隔"
                    />
                  </label>
                </>
              )}
            </ReadingDetails>
          </form>
          {draftProblem('query')}
          {searchLoading && !page ? (
            <PageLoading label="正在读取资料…" />
          ) : page ? (
            <div className="information-results">
              {page.purpose && (
                <p className="information-query-caption">
                  {page.purpose === '查找可用资料'
                    ? '当前可读的资料'
                    : '“' + page.purpose + '”的相关资料'}
                </p>
              )}
              {page.items.map((scope) => <ResultScope key={scope.key} scope={scope} model={model} />)}
            </div>
          ) : (
            <p className="information-empty">
              从一个问题或关键词开始。也可以直接查找所选类型的当前资料。
            </p>
          )}
          <ReadingDetails mode="inline"
            className="information-honor"
            onOpenChange={(isOpen)=> {
              const open = isOpen;
              setHonorOpen(open);
              if (open && rules === null)
                void run(async (valid) => {
                  const value = await client!.rules();
                  if (valid())
                    setRules(
                      value.rules.filter(
                        (item) => item.sourceProfile === 'facts-v2',
                      ),
                    );
                });
            }}
          >
            <ReadingSummary>查看某个人的荣誉依据</ReadingSummary>
            {honorOpen && (
              <div>
                <label>
                  选择人物
                  <select
                    value={honorSubject}
                    onChange={(event) => setHonorSubject(event.target.value)}
                  >
                    <option value="">从当前资料中的人物选择</option>
                    {visibleSubjects.map((id) => (
                      <option key={id} value={id}>
                        {person(id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  荣誉
                  <select
                    value={rule}
                    onChange={(event) => setRule(event.target.value)}
                  >
                    <option value="">选择一项荣誉</option>
                    {rules?.map((item) => (
                      <option key={ruleKey(item)} value={ruleKey(item)}>
                        {item.name ?? item.title ?? '荣誉'} · 第{' '}
                        {item.version ?? item.ruleVersion} 版
                      </option>
                    ))}
                  </select>
                </label>
                {rules && !rules.length && <p>当前没有可用的荣誉规则。</p>}
                <Button
                  disabled={busy || !rule || !honorSubject}
                  onClick={() =>
                    void run(async (valid) => {
                      const chosen=rules?.find(item=>ruleKey(item)===rule),ruleId=chosen?.id??chosen?.ruleId,ruleVersion=chosen?.version??chosen?.ruleVersion;
                      if(!ruleId||!ruleVersion)throw Error('这项荣誉的准确规则版本暂时不可用。');
                      const value = await client!.query({
                          purpose: query.trim() || '查看所选荣誉的依据',
                          sources: [
                            {
                              key: 'honor',
                              source: {
                                kind: 'honor',
                                request: {
                                  subjectId: honorSubject,
                                  ruleId,ruleVersion,
                                  limit: 8,
                                },
                              },
                            },
                          ],
                        });
                      if (valid()) setPage(value);
                    })
                  }
                >
                  查看依据
                </Button>
              </div>
            )}
          </ReadingDetails>
        </>

  );
}
