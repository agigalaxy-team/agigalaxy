import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftHistoryNavigation} from "../src/shared/navigation/draft-history-navigation.mjs";

/** @typedef {{route:string,key:string|null}} Point */
/** @typedef {Parameters<typeof createDraftHistoryNavigation>[0]['selectLeave']} SelectLeave */
/** @typedef {NonNullable<ReturnType<SelectLeave>>} Selection */
/** @param {Point} point @param {boolean} [cancelable] @param {unknown} [info] */
function intent(point,cancelable=true,info){
  let prevented=false;
  return{event:{navigationType:'traverse',cancelable,info,destination:{sameDocument:true,url:'https://example.test'+point.route,key:point.key??'legacy'},preventDefault(){prevented=true;}},prevented:()=>prevented};
}
function editor(){
  let valid=true;
  /** @type {Array<()=>void>} */
  const saves=[];
  return{selection:{isCurrent:()=>valid,leave:(/** @type {()=>void} */ complete)=>saves.push(complete)},saves,invalidate(){valid=false;}};
}
/** @param {boolean} [native] */
function historyHarness(native=true){
  const origin={route:'/app/publish?from=original#writing',key:native?'original':null},one={route:'/app/work?section=mine',key:native?'one':null},two={route:'/app/search?q=table',key:native?'two':null};
  let point=origin,rejectReplay=false,deferReplay=false;
  /** @type {Array<()=>boolean>} */
  const replayEvents=[];
  const initial=editor();
  /** @type {Selection|null} */
  let selection=initial.selection;
  const points=new Map([['original',origin],['one',one],['two',two]]);
  /** @type {Point[]} */
  const accepted=[];
  /** @type {string[]} */
  const traversed=[];
  /** @type {Array<'native'|'fallback'|null>} */
  const held=[];
  let failed=0;
  const navigation=createDraftHistoryNavigation({origin:'https://example.test',read:()=>point,selectLeave:()=>selection,accept:()=>accepted.push(point),held:mode=>held.push(mode),failed:()=>{failed++;},
    traverseTo:native?(key,info)=>{
      traversed.push(key);
      if(rejectReplay)return{committed:Promise.reject(Error('Navigation unavailable')),finished:Promise.reject(Error('Navigation unavailable'))};
      const target=points.get(key);assert.ok(target);
      const perform=()=>{const retry=intent(target,true,info);navigation.navigate(retry.event);if(retry.prevented())return false;point=target;navigation.pop();return true;};
      if(!deferReplay){assert.equal(perform(),true,'Only the permitted accurate key is replayed');return{committed:Promise.resolve(target),finished:Promise.resolve(target)};}
      const settled=new Promise((resolve,reject)=>replayEvents.push(()=>{const accepted=perform();if(accepted)resolve(target);else reject(Error('Traversal canceled'));return accepted;}));
      return{committed:settled,finished:settled};
    }:null});
  navigation.start();
  return{navigation,origin,one,two,accepted,traversed,held,initial,read:()=>point,failed:()=>failed,
    at(/** @type {Point} */ next){point=next;},select(/** @type {Selection|null} */ next){selection=next;},reject(/** @type {boolean} */ value){rejectReplay=value;},defer(){deferReplay=true;},
    deliver(/** @type {number} */ index=0){const event=replayEvents[index];assert.ok(event);return event();}};
}
/** @param {ReturnType<typeof editor>} value @param {number} [index] */
function saved(value,index=0){const callback=value.saves[index];assert.ok(callback,'The original editor was asked to save');callback();}

test('canceled Back keeps the source until saving, then uses the original exact entry once',()=>{
  const h=historyHarness(),back=intent(h.one);h.navigation.navigate(back.event);
  assert.equal(back.prevented(),true);assert.deepEqual(h.read(),h.origin);assert.equal(h.accepted.length,0);
  // A storage failure does not call the success callback. Retrying uses the same editor, not a read/reset.
  h.navigation.resume();assert.equal(h.initial.saves.length,2);saved(h.initial,1);saved(h.initial);
  assert.deepEqual(h.traversed,['one']);assert.deepEqual(h.accepted,[h.one]);assert.equal(h.held.at(-1),null);
});

test('an idle saved editor is not asked to replay within the original native dispatch microtasks',async()=>{
  const h=historyHarness(),back=intent(h.one);let dispatched=false;
  /** @type {()=>void} */
  let complete=()=>{};
  const boundary=new Promise(resolve=>{complete=()=>{dispatched=true;resolve(undefined);};});
  h.navigation.navigate({...back.event,afterDispatch:()=>boundary});
  assert.equal(back.prevented(),true);await Promise.resolve();assert.equal(h.initial.saves.length,0);assert.equal(h.traversed.length,0);
  complete();await boundary;assert.equal(dispatched,true);assert.equal(h.initial.saves.length,1);saved(h.initial);assert.deepEqual(h.accepted,[h.one]);
});

test('rapid Back intents share the held editor and only the latest accurate target is replayed',()=>{
  const h=historyHarness();h.navigation.navigate(intent(h.one).event);h.navigation.navigate(intent(h.two).event);
  assert.deepEqual(h.read(),h.origin);saved(h.initial);saved(h.initial,1);
  assert.deepEqual(h.traversed,['two']);assert.deepEqual(h.accepted,[h.two]);
});

test('another registration or identity invalidates the old save without adopting its navigation',()=>{
  const h=historyHarness();h.navigation.navigate(intent(h.one).event);h.initial.invalidate();const replacement=editor();h.select(replacement.selection);
  saved(h.initial);h.navigation.resume();assert.equal(replacement.saves.length,0);assert.equal(h.traversed.length,0);
  const next=intent(h.two);h.navigation.navigate(next.event);saved(replacement);
  assert.deepEqual(h.traversed,['two']);
});

test('same-room query ABA and ordinary app navigation cannot reuse an earlier callback',()=>{
  const h=historyHarness();h.at({route:'/app/rooms/room?message=A',key:'view-A'});h.navigation.changed();h.navigation.navigate(intent(h.one).event);
  h.at({route:'/app/rooms/room?message=B',key:'view-B'});h.navigation.changed();h.at({route:'/app/rooms/room?message=A',key:'new-view-A'});h.navigation.changed();
  saved(h.initial);assert.equal(h.traversed.length,0);assert.equal(h.accepted.length,0);
});

test('legacy and noncancelable Back retain the editor, then accept the actual last position without guessed movement',()=>{
  const h=historyHarness(false);h.at(h.one);h.navigation.pop();assert.equal(h.navigation.editorRoute(),h.origin.route);assert.equal(h.accepted.length,0);
  h.at(h.two);h.navigation.pop();saved(h.initial);saved(h.initial,1);
  assert.deepEqual(h.accepted,[h.two]);assert.equal(h.traversed.length,0);assert.equal(h.navigation.editorRoute(),h.two.route);
});

test('legacy save failure has a retry and shell disconnect still goes through the captured registration',()=>{
  const h=historyHarness(false);h.at(h.one);h.navigation.pop();h.navigation.resume();assert.equal(h.accepted.length,0);
  let disconnected=0;assert.equal(h.navigation.leave(()=>{disconnected++;}),true);saved(h.initial,2);saved(h.initial);
  assert.equal(disconnected,1);assert.equal(h.accepted.length,0);assert.equal(h.traversed.length,0);
});

test('a later browser Back supersedes a pending shell action instead of executing it at the new URL',()=>{
  const h=historyHarness(false);h.at(h.one);h.navigation.pop();let disconnected=0;h.navigation.leave(()=>{disconnected++;});
  h.at(h.two);h.navigation.pop();saved(h.initial,1);saved(h.initial);
  assert.equal(disconnected,0);assert.deepEqual(h.accepted,[h.two]);
});

test('an editor still mounting holds traversal and can resume once its actual registration is installed',()=>{
  const h=historyHarness(),mounted=editor();h.select({isCurrent:()=>true,leave:()=>{}});h.navigation.navigate(intent(h.one).event);
  assert.equal(h.accepted.length,0);h.select(mounted.selection);h.navigation.resume();saved(mounted);
  assert.deepEqual(h.traversed,['one']);
});

test('failed native replay keeps the original route and can retry without a second history entry',async()=>{
  const h=historyHarness();h.reject(true);h.navigation.navigate(intent(h.one).event);saved(h.initial);
  await Promise.resolve();await Promise.resolve();assert.equal(h.failed(),1);assert.deepEqual(h.read(),h.origin);assert.equal(h.accepted.length,0);
  h.reject(false);h.navigation.resume();saved(h.initial,1);assert.deepEqual(h.accepted,[h.one]);
});

test('a shell click before lazy editor registration is preserved and leaves only after its draft is saved',()=>{
  const h=historyHarness(),mounted=editor();let destination='';
  h.select({isCurrent:()=>true,leave:()=>{}});
  assert.equal(h.navigation.leave(()=>{destination='community';},true),true);
  assert.equal(destination,'');assert.equal(h.held.at(-1),'fallback');
  h.select(mounted.selection);h.navigation.resume();assert.equal(destination,'');
  saved(mounted);saved(mounted);assert.equal(destination,'community');assert.equal(h.held.at(-1),null);
});

test('rapid shell clicks keep the latest destination; identity changes and new routes cancel old pending work',()=>{
  const h=historyHarness(),mounted=editor();let destination='',valid=true;
  h.select({isCurrent:()=>valid,leave:()=>{}});
  h.navigation.leave(()=>{destination='community';},true);h.navigation.leave(()=>{destination='messages';},true);
  h.select(mounted.selection);h.navigation.resume();saved(mounted);assert.equal(destination,'messages');
  h.select({isCurrent:()=>valid,leave:()=>{}});h.navigation.leave(()=>{destination='stale';},true);
  valid=false;h.select(editor().selection);h.navigation.resume();assert.equal(destination,'messages');
  h.navigation.leave(()=>{destination='old-route';},true);h.at(h.one);h.navigation.changed();h.navigation.resume();
  assert.equal(destination,'messages');
});

test('ordinary reading without an editor never holds a shell action',()=>{
  const h=historyHarness();h.select(null);
  assert.equal(h.navigation.leave(()=>assert.fail('Caller handles ordinary navigation'),true),false);
  assert.equal(h.initial.saves.length,0);
});

test('fragment reading keeps the existing page while query changes still require saving',()=>{
  const h=historyHarness(),anchor={route:h.origin.route.split('#')[0]+'#main-content',key:'anchor'};
  const hash=intent(anchor);h.navigation.navigate(hash.event);assert.equal(hash.prevented(),false);h.at(anchor);h.navigation.pop();assert.equal(h.initial.saves.length,0);
  const query=intent({route:'/app/publish?from=changed#main-content',key:'query'});h.navigation.navigate(query.event);assert.equal(query.prevented(),true);assert.equal(h.initial.saves.length,1);
});

test('an anonymous reading page with no editor registration returns without an inert hold',()=>{
  const h=historyHarness();h.select(null);const back=intent(h.one);h.navigation.navigate(back.event);assert.equal(back.prevented(),false);
  h.at(h.one);h.navigation.pop();assert.deepEqual(h.accepted,[h.one]);assert.equal(h.initial.saves.length,0);assert.equal(h.held.at(-1),null);
});

test('closing the owning view makes any earlier save completion inert',()=>{
  const h=historyHarness();h.navigation.navigate(intent(h.one).event);h.navigation.stop();saved(h.initial);assert.equal(h.traversed.length,0);assert.equal(h.accepted.length,0);
});

test('a replay event arriving after an owner or route switch is canceled rather than treated as a new Back',async()=>{
  const h=historyHarness();h.defer();h.navigation.navigate(intent(h.one).event);saved(h.initial);h.initial.invalidate();
  const other={route:'/app/publish?owner=another',key:'another-owner'};h.at(other);h.navigation.changed();h.select(editor().selection);
  assert.equal(h.deliver(),false);await Promise.resolve();await Promise.resolve();assert.deepEqual(h.read(),other);assert.equal(h.accepted.length,0);assert.equal(h.failed(),0);
});

test('an earlier replay event cannot consume a later rapid Back permit',async()=>{
  const h=historyHarness();h.defer();h.navigation.navigate(intent(h.one).event);saved(h.initial);
  h.navigation.navigate(intent(h.two).event);saved(h.initial,1);assert.equal(h.deliver(),false);assert.equal(h.deliver(1),true);
  await Promise.resolve();await Promise.resolve();assert.deepEqual(h.accepted,[h.two]);assert.equal(h.failed(),0);
});

test('the original listener protects a queued replay during owning-view cleanup, then releases',async()=>{
  const h=historyHarness();h.defer();h.navigation.navigate(intent(h.one).event);saved(h.initial);let released=false;
  const cleanup=new Promise(resolve=>h.navigation.stop(()=>{released=true;resolve(undefined);}));
  assert.equal(released,false);assert.equal(h.deliver(),false);assert.deepEqual(h.read(),h.origin);
  await cleanup;assert.equal(released,true);assert.equal(h.accepted.length,0);
});
