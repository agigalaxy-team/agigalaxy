const processStates=['running','stopped','failed','not-applicable','unknown'];
const healthBases=['container-healthcheck','native-health-endpoint','prometheus-target','prometheus-probe','not-connected'];

// Count only the already-projected list. An unavailable/truncated input never
// becomes a whole-system healthy count, and a metric target stays its own basis.
export function agentOsMaintenanceComponentSummary(components,sourceTotal){
 if(!Array.isArray(components))return {basis:'returned-component-list',available:false,total:null,sourceTotal:null,complete:false,processByState:null,healthByBasis:null};
 const processByState=Object.fromEntries(processStates.map(state=>[state,0])),groups=new Map();
 for(const row of components){
  const process=row?.processAvailability?.state==='available'&&processStates.includes(row.processState)?row.processState:'unknown';
  processByState[process]++;
  const basis=healthBases.includes(row?.healthBasis)?row.healthBasis:'other-or-unavailable';
  if(!groups.has(basis))groups.set(basis,{basis,total:0,healthy:0,unhealthy:0,unknown:0,available:0,notConfigured:0,unavailable:0});
  const group=groups.get(basis),state=row?.healthAvailability?.state;
  group.total++;group[state==='available'?'available':state==='not-configured'?'notConfigured':'unavailable']++;
  group[state==='available'&&['healthy','unhealthy'].includes(row.health)?row.health:'unknown']++;
 }
 return {basis:'returned-component-list',available:true,total:components.length,
  sourceTotal:Number.isSafeInteger(sourceTotal)&&sourceTotal>=0?sourceTotal:null,
  complete:Number.isSafeInteger(sourceTotal)&&sourceTotal===components.length,
  processByState,healthByBasis:[...groups.values()]};
}
