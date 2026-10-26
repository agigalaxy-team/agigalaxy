import type {ModelSettingsUsage} from "../../components/models/model-settings-types";

export const modelUsageDomains={overview:'综合运营',governance:'治理审查',messaging:'公告与消息',discovery:'内容与发现',maintenance:'运行诊断'} as const;
export const modelUsageCallLabels={total:'调用总量',completed:'已完成',failed:'失败',unknown:'结果未知'} as const;
export const modelUsageTokenLabels={input:'输入 Token',output:'输出 Token',cachedInput:'缓存输入 Token',reasoning:'思考 Token',total:'总 Token'} as const;
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const iso=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const safeName=(value:unknown)=>typeof value==='string'&&value.trim()&&value.length<=100&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim():null;
const unknownCalls=()=>({total:null,completed:null,failed:null,unknown:null});
const unknownTokens=()=>({input:null,output:null,total:null,cachedInput:null,reasoning:null});
function calls(value:unknown){const row=object(value);return {total:count(row?.total),completed:count(row?.completed),failed:count(row?.failed),unknown:count(row?.unknown)};}
function tokens(value:unknown){const row=object(value);return {input:count(row?.input),output:count(row?.output),total:count(row?.total),cachedInput:count(row?.cachedInput),reasoning:count(row?.reasoning)};}

/** Only the closed basic usage DTO is retained; no provider response or billing fields. */
export function modelUsage(value:unknown):ModelSettingsUsage|null{
 const root=object(value),availability=object(root?.availability);if(!root||![7,30].includes(Number(root.days))||!availability||!['available','unavailable'].includes(String(availability.state)))return null;
 const available=availability.state==='available',from=iso(root.from),to=iso(root.to),coverageFrom=iso(root.coverageFrom);
 const meta={checkedAt:count(root.checkedAt),readExpiresAt:count(root.readExpiresAt),metadataOnly:true as const};
 if(meta.checkedAt===null||meta.readExpiresAt===null||root.metadataOnly!==true||meta.readExpiresAt<meta.checkedAt||meta.readExpiresAt-meta.checkedAt>31)return null;
 const byScenario=available&&Array.isArray(root.byScenario)?root.byScenario.flatMap(value=>{const row=object(value);return row&&Object.hasOwn(modelUsageDomains,String(row.domain))?[{domain:row.domain as keyof typeof modelUsageDomains,calls:calls(row.calls),tokens:tokens(row.tokens),unknownUsageCalls:count(row.unknownUsageCalls)}]:[];}):[];
 const byModel=available&&Array.isArray(root.byModel)?root.byModel.flatMap(value=>{const row=object(value);return row&&typeof row.modelRecordId==='string'&&uuid.test(row.modelRecordId)?[{modelRecordId:row.modelRecordId.toLowerCase(),calls:calls(row.calls),tokens:tokens(row.tokens),unknownUsageCalls:count(row.unknownUsageCalls)}]:[];}):[];
 const complete=!available?null:root.coversWholeWindow===false?false:root.coversWholeWindow===true&&!!coverageFrom&&!!from&&!!to&&Date.parse(coverageFrom)<=Date.parse(from)&&Date.parse(to)>Date.parse(from)?true:null;
 return {availability:{state:available?'available':'unavailable'},days:Number(root.days) as 7|30,from:available?from:null,to:available?to:null,coverageFrom:available?coverageFrom:null,coversWholeWindow:complete,
  calls:available?calls(root.calls):unknownCalls(),tokens:available?tokens(root.tokens):unknownTokens(),unknownUsageCalls:available?count(root.unknownUsageCalls):null,byScenario,byModel,
  basis:{source:object(root.basis)?.source==='native-model-gateway-ledger'?'native-model-gateway-ledger':'not-connected',billing:'not-provided'},checkedAt:meta.checkedAt,readExpiresAt:meta.readExpiresAt,metadataOnly:true};
}
export function modelUsageNumber(value:unknown){return count(value)===null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(Number(value));}
export function modelUsageTime(value:unknown){const date=iso(value);return date?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(date)):'未取得';}
export function modelUsageCoverage(value:ModelSettingsUsage){
 const range=iso(value.from)&&iso(value.to)?modelUsageTime(value.from)+' 至 '+modelUsageTime(value.to):'实际统计时段未取得';
 return {range,complete:value.coversWholeWindow===false?false:value.coversWholeWindow===true&&!!iso(value.coverageFrom)?true:null,start:iso(value.coverageFrom)?modelUsageTime(value.coverageFrom):null};
}
export function modelUsageCallSegments(value:ModelSettingsUsage['calls']){
 const {total,completed,failed,unknown}=value;if(total===null||total<=0||[completed,failed,unknown].some(item=>item===null)||Number(completed)+Number(failed)+Number(unknown)!==total)return null;
 return (['completed','failed','unknown'] as const).map(key=>({key,label:modelUsageCallLabels[key],value:value[key]!,percent:value[key]!/total*100}));
}
export function modelUsageRows(value:ModelSettingsUsage,group:'scenario'|'model',modelNames:Readonly<Record<string,string>>={}){
 const entries=group==='scenario'?value.byScenario.map(row=>({key:row.domain,label:modelUsageDomains[row.domain]??'领域未记录',...row})):value.byModel.map(row=>({key:row.modelRecordId,label:safeName(modelNames[row.modelRecordId])??'模型名称未记录',...row}));
 return entries.sort((a,b)=>(b.calls.total??-1)-(a.calls.total??-1)||a.label.localeCompare(b.label,'zh-CN'));
}
