import {searchQualityDraftSchema,searchQualityApplySchema,parseSearchQuality} from "../../shared/operations-search-quality-schema.mjs";
import {phases,operationView} from './helpers.mjs';
import {SearchQualityReadModel} from './read-model.mjs';

// Formal search-quality command service; original public constructor and command signatures remain unchanged.
export class OperationsSearchQualityService extends SearchQualityReadModel{
 async command(operator,kind,input,options={}){
  const schema=kind==='draft'?searchQualityDraftSchema:searchQualityApplySchema,x=parseSearchQuality(schema,input),prepared=await this.prepare(operator,kind,x,options);
  let row=prepared.row;if(kind!=='draft'){if(row.phase==='prepared')row=await this.submit(operator,row,options.authorize);if(phases.has(row.phase))row=await this.reconcile(row.operation_id);}
  const action=kind==='draft'?'search-quality.configure':kind==='apply'?'search-quality.publish':'search-quality.restore';await this.currentActor(operator,action,options.authorize);
  return {...operationView(row,prepared.replayed),...this.metadata()};
 }
 saveDraft(operator,input,options){return this.command(operator,'draft',input,options);}
 apply(operator,input,options){return this.command(operator,'apply',input,options);}
 restore(operator,input,options){return this.command(operator,'restore',input,options);}
}
