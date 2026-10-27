import test from 'node:test';
import assert from 'node:assert/strict';
import {websiteRoutes} from '../deploy/caddy-routes.mjs';

// Evaluate this fragment's native host/header matcher projection. A null header
// value means absent in Caddy; it is distinct from an empty supplied header.
function target(routes,host,headers={}){
 const supplied=new Map(Object.entries(headers).map(([key,value])=>[key.toLowerCase(),value]));
 const route=routes.find(route=>route.match.some(matcher=>matcher.host.includes(host)
  &&Object.entries(matcher.header??{}).every(([name,values])=>values===null?!supplied.has(name.toLowerCase()):values.includes(supplied.get(name.toLowerCase())))
  &&Object.entries(matcher.header_regexp??{}).every(([name,rule])=>new RegExp(rule.pattern).test(supplied.get(name.toLowerCase())??''))));
 return route?.handle[0].upstreams[0].dial;
}
test('website deployment fragment pins current/previous IDs, first-upgrade RSC and documents to configured host/ports',()=>{
 const config={origin:'https://website.example',port:3100,deploymentId:'release-new_2'},host='website.example';
 const ordinary=websiteRoutes({origin:config.origin,port:config.port});
 assert.deepEqual(ordinary,[{match:[{host:[host]}],handle:[{handler:'reverse_proxy',upstreams:[{dial:'127.0.0.1:3100'}]}],terminal:true}]);
 const retained=websiteRoutes({...config,previous:{port:3101,deploymentId:'release-old_1'}});
 assert.equal(target(retained,host,{'x-deployment-id':'release-new_2',RSC:'1'}),'127.0.0.1:3100');
 assert.equal(target(retained,host,{'x-deployment-id':'release-old_1',RSC:'1'}),'127.0.0.1:3101');
 assert.equal(target(retained,host,{'x-deployment-id':'unconfigured',RSC:'1'}),'127.0.0.1:3100');
 assert.equal(target(retained,host),'127.0.0.1:3100');
 const legacy=websiteRoutes({...config,previous:{port:3101,deploymentId:null}});
 assert.equal(target(legacy,host,{RSC:'1'}),'127.0.0.1:3101');
 assert.equal(target(legacy,host,{RSC:'1','X-Deployment-Id':''}),'127.0.0.1:3100');
 assert.equal(target(legacy,host,{RSC:'1','X-Deployment-Id':config.deploymentId}),'127.0.0.1:3100');
 assert.equal(target(legacy,host,{RSC:'0'}),'127.0.0.1:3100');
 assert.equal(target(legacy,host,{'Next-Action':'legacy-action-hash'}),'127.0.0.1:3101');
 assert.equal(target(legacy,host,{'Next-Action':''}),'127.0.0.1:3100');
 assert.equal(target(legacy,host,{'Next-Action':'legacy-action-hash','X-Deployment-Id':config.deploymentId}),'127.0.0.1:3100');
 assert.equal(target(legacy,host,{'Content-Type':'application/json'}),'127.0.0.1:3100');
 assert.equal(target(legacy,host),'127.0.0.1:3100');
 assert.equal(target(legacy,'other.example',{RSC:'1'}),undefined);
 assert.equal(target(legacy,'other.example',{'Next-Action':'legacy-action-hash'}),undefined);
 const admin=websiteRoutes({...config,origin:'https://admin.example',previous:{port:3101,deploymentId:'release-old_1'}});
 assert.equal(target(admin,'admin.example',{'x-deployment-id':'release-old_1'}),'127.0.0.1:3101');
 for(const port of [0,1023,65536,'3101',NaN]){
  assert.throws(()=>websiteRoutes({...config,port}));
  assert.throws(()=>websiteRoutes({...config,previous:{port,deploymentId:'release-old_1'}}));
 }
 for(const deploymentId of ['',null,'*','../old','old\r\nX-Host: other','x'.repeat(129)])assert.throws(()=>websiteRoutes({...config,deploymentId}));
 for(const deploymentId of ['',undefined,'*','../old',config.deploymentId])assert.throws(()=>websiteRoutes({...config,previous:{port:3101,deploymentId}}));
 assert.throws(()=>websiteRoutes({...config,previous:{port:3100,deploymentId:'release-old_1'}}));
 assert.throws(()=>websiteRoutes({...config,origin:'https://*.example'}));
 assert.throws(()=>websiteRoutes({...config,previous:{port:3101,deploymentId:'release-old_1',upstream:'other.example'}}));
});
