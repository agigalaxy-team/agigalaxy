'use client';

import {QueryBuilder} from 'react-querybuilder';
import type {Field,RuleGroupType,ValueEditorProps} from 'react-querybuilder';
import type {RulesBusinessRule,RulesCatalog,RulesControls,RulesGroup} from './rules-types';
import {rulesQuery,rulesSame} from '../lib/rules-view-model';

type Context={catalog:RulesCatalog;policy:RulesControls};
function RuleValue(props:ValueEditorProps){
 const {catalog,policy}=props.context as Context,field=catalog.fields.find(item=>item.name===props.field),id='rules-condition-'+props.path.join('-');
 if(!field)return <span>条件暂不可用</span>;
 const options=field.kind==='select'?field.values:field.kind.endsWith('-list')?policy.lists.filter(list=>list.kind===(field.kind==='keyword-list'?'keyword':'domain')).map(list=>({name:list.id,label:list.name||'未命名名单'})):null;
 if(options)return <select id={id} aria-label={field.label+'的值'} disabled={props.disabled} value={typeof props.value==='string'?props.value:''} onChange={event=>props.handleOnChange(event.target.value)}><option value="">请选择{field.kind==='select'?'取值':'名单'}</option>{options.map(option=><option key={option.name} value={option.name}>{option.label}</option>)}</select>;
 return <input id={id} aria-label={field.label+'的值'} type="number" min={0} step={1} disabled={props.disabled} value={typeof props.value==='number'&&Number.isFinite(props.value)?props.value:typeof props.value==='string'?props.value:''} onChange={event=>props.handleOnChange(event.target.value===''?'':Number(event.target.value))}/>;
}
export function RulesConditionEditor({rule,policy,catalog,disabled,onChange}:{rule:RulesBusinessRule;policy:RulesControls;catalog:RulesCatalog;disabled:boolean;onChange:(value:RulesGroup)=>void}){
 const available=catalog.fields.filter(field=>rule.targets.length>0&&rule.targets.every(target=>field.targets.includes(target)));
 // Keep an already saved field visible when the operator changes the target;
 // validation requires correcting the mismatch before anything is published.
 const used=new Set<string>();function visit(group:RulesGroup){for(const node of group.rules)if('rules' in node)visit(node);else used.add(node.field);}visit(rule.conditions);
 const fields:Field[]=catalog.fields.filter(field=>available.includes(field)||used.has(field.name)).map(field=>({name:field.name,label:field.label+(available.includes(field)?'':' · 当前操作不支持'),defaultValue:field.kind==='number'?0:field.kind==='select'?field.values?.[0]?.name??'':policy.lists.find(list=>list.kind===(field.kind==='keyword-list'?'keyword':'domain'))?.id??''}));
 function withIds(group:RulesGroup,path='root'):RuleGroupType{return {...group,id:rule.id+':'+path,rules:group.rules.map((node,index)=>'rules' in node?withIds(node,path+'.'+index):{...node,id:rule.id+':'+path+'.'+index})};}
 if(!fields.length)return <p className="rules-note">选择适用操作后可组合条件。</p>;
 return <div className="rules-query" aria-label="组合条件编辑"><div className="rules-condition-columns" aria-hidden="true"><span>判断内容</span><span>关系</span><span>取值</span><span>操作</span></div><QueryBuilder fields={fields} query={withIds(rule.conditions)} onQueryChange={query=>{const group=rulesQuery(query);if(!rulesSame(group,rule.conditions))onChange(group);}} disabled={disabled} context={{catalog,policy} satisfies Context} getOperators={field=>catalog.fields.find(item=>item.name===field)?.operators??[]} getDefaultField={available[0]?.name??fields[0].name} getDefaultOperator={field=>catalog.fields.find(item=>item.name===field)?.operators[0]?.name??'eq'} combinators={[{name:'and',label:'同时满足'},{name:'or',label:'满足任一'}]} resetOnFieldChange resetOnOperatorChange={false} showCloneButtons={false} showLockButtons={false} showNotToggle={false} showShiftActions={false} showCombinatorsBetweenRules={false} showMuteButtons={false} showUngroupButtons={false} enableDragAndDrop={false} addRuleToNewGroups={false} maxLevels={7} controlElements={{valueEditor:RuleValue}} translations={{addRule:{label:'添加条件',title:'添加条件'},addGroup:{label:'添加条件组',title:'添加同时或任一条件组'},removeRule:{label:'删除',title:'删除这个条件'},removeGroup:{label:'删除组',title:'删除这个条件组'},fields:{title:'判断内容'},operators:{title:'判断关系'},combinators:{title:'条件组合方式'},value:{title:'条件取值'}}}/></div>;
}
