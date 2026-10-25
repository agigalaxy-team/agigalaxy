/**
 * @typedef {{week:number,count:number|null,ratio:number|null,state:'recorded'|'unknown'|'not-reached'}} RetentionCell
 * @typedef {{cohort:string,average:boolean,size:number|null,cells:RetentionCell[]}} RetentionRow
 * @typedef {{rows:RetentionRow[],weeks:number[]}} RetentionData
 */
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:null;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const day=86400000,week=7*day;
function cohortDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value))return null;
 const date=value.slice(0,10),at=Date.parse(date+'T00:00:00Z');
 return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===date?at:null;
}

/**
 * Shared rendering/agent interpretation of native weekly cohorts. Native
 * processCohortData fills future cells with zero, so those are never copied
 * as an observed rate. Only an acknowledged native timezone selects an exact
 * calendar day. Without it, the +/- one-day range preserves uncertainty at
 * week boundaries; the business application's timezone is not substituted.
 * @param {unknown} value
 * @param {number} checkedAt Server observation time, epoch seconds.
 * @param {string|null|undefined} timeZone Acknowledged native cohort timezone.
 * @returns {RetentionData|null}
 */
export function normalizeAnalyticsRetention(value,checkedAt,timeZone){
 if(!Array.isArray(value)||value.length>100||!Number.isFinite(checkedAt)||checkedAt<0)return null;
 const source=value.map(object).filter(row=>row&&(row.cohort_interval==='Weighted Average'||cohortDate(row.cohort_interval)!==null)&&Array.isArray(row.values)&&Array.isArray(row.percentages));
 if(value.length&&!source.length)return null;
 let calendarAt=checkedAt*1000,uncertain=true;
 if(typeof timeZone==='string'&&timeZone){try{
  const parts=new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(calendarAt)),part=type=>Number(parts.find(item=>item.type===type)?.value);
  calendarAt=Date.UTC(part('year'),part('month')-1,part('day'));uncertain=false;
 }catch{/* An unknown native timezone must not silently become the host zone. */}}
 const age=(row,edge)=>{const start=cohortDate(row.cohort_interval);return start===null?null:Math.floor((calendarAt+(uncertain?(edge==='earliest'?-day:day):0)-start)/week);};
 const cohorts=source.filter(row=>row.cohort_interval!=='Weighted Average');
 const oldest=edge=>cohorts.length?Math.max(...cohorts.map(row=>age(row,edge))):null;
 const width=Math.min(13,Math.max(0,...source.map(row=>Math.max(row.values.length,row.percentages.length)))),weeks=Array.from({length:width},(_,index)=>index);
 /** @type {RetentionRow[]} */
 const rows=source.map(row=>{
  const average=row.cohort_interval==='Weighted Average',earliest=average?oldest('earliest'):age(row,'earliest'),last=average?oldest('latest'):age(row,'latest'),size=number(row.sum);
  /** @type {RetentionCell[]} */
  const cells=weeks.map(index=>{
   if(last===null||earliest===null)return{week:index,count:null,ratio:null,state:'unknown'};
   if(index>last)return{week:index,count:null,ratio:null,state:'not-reached'};
   if(index>earliest)return{week:index,count:null,ratio:null,state:'unknown'};
   const count=number(row.values[index]),rate=number(row.percentages[index]),ratio=rate!==null&&rate<=1&&size!==null&&size>0?rate:null;
   return{week:index,count,ratio,state:ratio===null?'unknown':'recorded'};
  });
  return{cohort:String(row.cohort_interval),average,size,cells};
 });
 return{rows:rows.sort((a,b)=>Number(b.average)-Number(a.average)||a.cohort.localeCompare(b.cohort)),weeks};
}
