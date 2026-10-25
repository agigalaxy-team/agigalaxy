import {forumTopics,forumUnclassifiedTopic} from "../../shared/community-forum-topics-v1.mjs";
import {fail,policyView,themeView} from './helpers.mjs';

// Current management authority and the original category/tag/theme and policy facts.
export class RecommendationState{
 constructor({db,endpoint,permissions,businessAdmin,source,openpanel=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,permissions,businessAdmin,source,openpanel,now});}
 metadata(){return {checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 async authorize(actor,action,db){if(!this.permissions)fail('operations_authorization_unavailable',503);return this.permissions.requireAction(actor,action,db?{db}:{});}
 async catalogWithin(db){
  const tags=(await db.query('SELECT id,name,revision,enabled FROM operations_forum_tags_v1 WHERE endpoint=$1 ORDER BY name,id',[this.endpoint])).rows;
  const themes=(await db.query('SELECT * FROM operations_recommendation_themes_v1 WHERE endpoint=$1 ORDER BY label,id',[this.endpoint])).rows;
  return [...[...forumTopics,forumUnclassifiedTopic].map(topic=>({key:'category:'+topic.id,id:null,label:topic.label,kind:'category',version:0,enabled:true,mapping:{categories:[topic.id],tagIds:[],queryTerms:[]},source:'forum-category'})),
   ...tags.map(tag=>({key:'tag:'+tag.id,id:tag.id,label:tag.name,kind:'tag',version:tag.revision,enabled:tag.enabled,mapping:{categories:[],tagIds:[tag.id],queryTerms:[]},source:'forum-tag'})),...themes.map(themeView)];
 }
 async policyWithin(db){return policyView((await db.query('SELECT * FROM operations_recommendation_policy_v1 WHERE endpoint=$1',[this.endpoint])).rows[0]);}
}
