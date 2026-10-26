/** Actual public2 schema, controller and formatter; only native data execution
 * and project lookup are explicit doubles. No analytics events are inserted. */
import {expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({calls:[] as any[]}));
vi.mock('../../packages/db/index.ts',async()=>{
 const {format}=await import('../../packages/db/src/engine/format');
 return {
  ClientType:{read:'read'},
  db:{project:{findUnique:async({where}:any)=>where.id==='11111111-1111-4111-8111-111111111111'?{id:where.id}:null}},
  getSettingsForProject:async()=>({timezone:'UTC'}),
  ChartEngine:{execute:async(input:any)=>{
   state.calls.push(input);
   const concrete=input.series.map((definition:any,definitionIndex:number)=>({id:'fixture-'+definitionIndex,name:[definition.name],definitionIndex,definition,context:{event:definition.name,breakdowns:[]},data:[{date:'2026-10-23',count:definitionIndex===0?1:4}]}));
   return format(concrete,input.series,false);
  }},
  getEventList:vi.fn(),getEventsCount:vi.fn(),
 };
});

import {chartSchemeFull,charts} from '../../apps/api/src/controllers/export.controller';

it('native chart input preserves optional series and legacy event IDs through actual handler and sorted formatter without changing project scope',async()=>{
 const projectId='11111111-1111-4111-8111-111111111111';
 const definitions=[{id:'galaxy-searches',name:'search',segment:'event',filters:[{id:'A',name:'properties.purpose',operator:'is',value:['site-usage-analytics']}]},{id:'galaxy-no-results',name:'search',segment:'event',filters:[{id:'B',name:'properties.galaxy_search_result',operator:'is',value:['no-results']}]}];
 const base={projectId,startDate:'2026-10-16T00:00:00Z',endDate:'2026-10-23T00:00:00Z',interval:'day',range:'7d',previous:false,breakdowns:[]};
 for(const inputKey of ['series','events']){
  const query=chartSchemeFull.parse({...base,[inputKey]:definitions});
  expect((query as any)[inputKey].map((row:any)=>row.id)).toEqual(['galaxy-searches','galaxy-no-results']);
  const headers:Record<string,string>={};
  const result=await charts({query,client:{type:'read',projectId,organizationId:'fixture-org'}} as any,{header:(name:string,value:string)=>{headers[name]=value;}} as any);
  // Equal event names and native sum sorting must not swap their identities.
  expect(result.series.map(row=>row.event.id)).toEqual(['galaxy-no-results','galaxy-searches']);
  expect(result.series.find(row=>row.event.id==='galaxy-searches')?.metrics.sum).toBe(1);
  expect(result.series.find(row=>row.event.id==='galaxy-no-results')?.metrics.sum).toBe(4);
  expect(state.calls.at(-1)?.series[1].filters).toEqual(definitions[1]?.filters);
  expect(headers.Link).toBe('<https://agigalaxy.org/open-source/openpanel-public2-galaxy-search-20261023/source.tar.gz>; rel="source"');
 }
 const plain=chartSchemeFull.parse({...base,series:[{name:'search'}]});
 expect(plain.series?.[0]).not.toHaveProperty('id');
 for(const id of ['', 'x'.repeat(101),42])expect(chartSchemeFull.safeParse({...base,series:[{name:'search',id}]}).success).toBe(false);
 const before=state.calls.length;
 await expect(charts({query:chartSchemeFull.parse({...base,projectId:'22222222-2222-4222-8222-222222222222',series:definitions}),client:{type:'read',projectId,organizationId:'fixture-org'}} as any,{} as any)).rejects.toThrow('You do not have access to this project');
 expect(state.calls).toHaveLength(before);
});
