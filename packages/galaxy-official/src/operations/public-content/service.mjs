import {digest} from "../../shared/digest.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsParse} from "../../operations-content-visibility.mjs";
import {operationsContentBatchSchema,operationsContentBatchPreviewSchema} from "../../shared/operations-forum-content-schema.mjs";
import {key} from './helpers.mjs';
import {PublicContentCommands} from './commands.mjs';

// Formal public-content service with original per-object batch preview/recheck and savepoint-isolated results.
export class OperationsForumContentService extends PublicContentCommands{
 async previewWithin(db,actor,x){
  const items=[];
  for(const item of x.items){let title=null,code=null;try{const view=await this.viewWithin(db,actor,item.kind,item.id);title=view.title;
   if(view.version!==item.expectedVersion)code='operations_source_changed';else if(view.visibility.version!==item.expectedRevision)code='operations_visibility_changed';
   else if(!(x.kind==='hide'?view.capabilities.canBatchHide:view.capabilities.canBatchRestore))code='operations_source_unavailable';
   else if(x.kind==='hide'&&(x.until<=this.now()||x.until>this.now()+this.maxHideSeconds))code='operations_hide_expiry';
  }catch(error){if(!(error instanceof ServiceError)||![403,404,409].includes(error.status))throw error;code=error.code;}
   items.push({...item,title,eligible:code===null,reason:code});
  }
  return {items,checkedAt:this.now(),maximumItems:25};
 }
 preview(operator,input){const x=operationsParse(operationsContentBatchPreviewSchema,input);return this.run(operator,false,'community-content-batch-preview',{kind:x.kind,count:x.items.length},(db,actor)=>this.previewWithin(db,actor,x));}
 async batch(operator,input){const x=operationsParse(operationsContentBatchSchema,input),{reason,...metadata}=x;
  const saved=await this.command(operator,'community-content-batch-visibility',{...metadata,reasonDigest:digest(reason)},async(db,actor)=>{
   const results=[];
   for(const item of [...x.items].sort((a,b)=>key(a).localeCompare(key(b)))){
    await db.query('SAVEPOINT content_item');
    try{const visibility=await this.visibilityWithin(db,actor,item.kind,item.id,{...x,...item,kind:x.kind},{batch:true});
     await db.query('RELEASE SAVEPOINT content_item');results.push({kind:item.kind,id:item.id,status:'applied',code:null,visibility});
    }catch(error){await db.query('ROLLBACK TO SAVEPOINT content_item');await db.query('RELEASE SAVEPOINT content_item');
     if(!(error instanceof ServiceError)||![400,403,404,409].includes(error.status))throw error;
     results.push({kind:item.kind,id:item.id,status:'rejected',code:error.code});
    }
   }
   const byKey=new Map(results.map(result=>[key(result),result]));return {items:x.items.map(item=>byKey.get(key(item))),counts:{applied:results.filter(item=>item.status==='applied').length,rejected:results.filter(item=>item.status==='rejected').length}};
  });return {...saved,replayed:saved.replayed??false};
 }
}
