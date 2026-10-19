const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const objects=new RegExp('^/app/(tasks|rooms|projects)/('+uuid+')$','i');
const versions=new RegExp('^/app/(capsules|community/posts)/('+uuid+')(?:/versions/('+uuid+'))?$','i');
const simple=new Map([['/app/bookmarks','bookmarks'],['/app/match','match'],['/app/publish','publish'],['/app/participate','participate'],['/app/rooms','messages'],
 ['/app/search','search'],['/app/capsules','capsules'],['/app/settings/privacy','privacy'],['/app/settings/summaries','summaries'],['/app/notifications','notifications'],['/app/community','community']]);

// Map only exact routes already supported by Native navigationSchema. A query,
// section or search that Native cannot carry is never silently discarded.
export function localGalaxyReturnObject(target){
 if(typeof target!=='string'||target.length>2048||target.includes('?')||target.includes('#')||target.includes('\\'))return null;
 const object=objects.exec(target);if(object)return{kind:({tasks:'task',rooms:'room',projects:'project'})[object[1].toLowerCase()],id:object[2]};
 const version=versions.exec(target);if(version)return{kind:version[1].toLowerCase()==='capsules'?'capsule':'post',id:version[2],...(version[3]?{versionId:version[3]}:{})};
 const kind=simple.get(target);return kind?{kind}:null;
}
