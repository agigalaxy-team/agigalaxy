import {normalizeRecommendationTerm} from '../shared/operations-recommendation-schema.mjs';

export const recommendationAlgorithm='galaxy-opportunity-v1';
export const recommendationFixedConstraints=Object.freeze({personalNeeds:true,supply:true,negativeFeedback:true});
export function defaultRecommendationPolicy(){return {version:0,enabled:false,directions:[],controls:{avoidRepetition:false,avoidConcentration:false},fixedConstraints:recommendationFixedConstraints,updatedAt:null,algorithm:recommendationAlgorithm};}
export function recommendationThemeMatches(theme,document){return theme.enabled&&(theme.mapping.categories.includes(document.topic)||theme.mapping.tagIds.some(id=>document.tagIds?.includes(id)));}
export const recommendationThemeKeys=(themes,document)=>themes.filter(theme=>recommendationThemeMatches(theme,document)).map(theme=>theme.key);
export function recommendationQueryMatches(theme,query){return theme.enabled&&theme.mapping.queryTerms.some(term=>normalizeRecommendationTerm(term)===normalizeRecommendationTerm(query));}

// Gorse's candidate order remains the basis. An explicit direction can move an
// item only across its immediate neighbour, once. Conflicting mapped directions
// cancel; 'keep' has no bonus. There is no population quota or invented score.
export function applyRecommendationControl(candidates,{policy,themes,previouslyExposed=new Set()}){
 if(!policy.enabled)return candidates;
 const directions=new Map(policy.directions.map(item=>[item.key,item.direction]));
 const rows=candidates.map(candidate=>{
  const themeKeys=recommendationThemeKeys(themes,candidate.document),values=themeKeys.map(key=>directions.get(key));
  const increase=values.includes('increase'),decrease=values.includes('decrease');
  return {...candidate,themeKeys,direction:increase===decrease?0:increase?1:-1};
 });
 for(let index=0;index+1<rows.length;index++)if(rows[index+1].direction>rows[index].direction){[rows[index],rows[index+1]]=[rows[index+1],rows[index]];index++;}
 const selected=[],remaining=[...rows];
 while(remaining.length){
  const previous=selected.at(-1),previousThemes=previous?.themeKeys.filter(key=>key.startsWith('theme:'))??[];
  const collides=row=>!!previous&&(previous.document.authorAccountId&&previous.document.authorAccountId===row.document.authorAccountId||
   (previousThemes.length?row.themeKeys.some(key=>previousThemes.includes(key)):previous.document.topic===row.document.topic));
  // Prefer an alternative to the latest actual displayed request. This is
  // not a permanent exclusion or a new time-based user-data policy.
  const alternatives=remaining.map((row,index)=>({row,index}));
  const fresh=policy.controls.avoidRepetition?alternatives.filter(({row})=>!previouslyExposed.has(row.document.id)):alternatives;
  const pool=fresh.length?fresh:alternatives;
  const different=policy.controls.avoidConcentration?pool.find(({row})=>!collides(row)):null;
  const index=(different??pool[0]).index;selected.push(remaining.splice(index,1)[0]);
 }
 return selected;
}
