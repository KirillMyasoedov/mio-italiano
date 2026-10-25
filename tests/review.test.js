import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {pendingDue,validSubscription} from '../reminder-schedule.js';
function app(){
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',classList:{add(){},remove(){},toggle(){}},replaceChildren(){},append(){},style:{}});return elements.get(id)};
 const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>element(Symbol())},localStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>String(Math.random())},window:{addEventListener(){}},navigator:{},location:{hash:''},setInterval(){},setTimeout(){},clearTimeout(){},console});
 vm.runInContext(readFileSync(new URL('../app.js',import.meta.url),'utf8'),context);
 return code=>vm.runInContext(code,context);
}
test('practice repeats difficult phrases until easy, without mutating schedule',()=>{
 const run=app();
 run("phrases=phrases.slice(0,2);practiceOnly=true;resetReview();globalThis.original=JSON.stringify(phrases)");
 assert.equal(run('practicePool.size'),2);
 run('grade(0)');assert.equal(run('practicePool.size'),2);
 assert.equal(run('[...practicePool.values()].includes(8)'),true);
 run('grade(1)');assert.equal(run('[...practicePool.values()].includes(4)'),true);
 run('grade(2)');assert.equal(run('practicePool.size'),2);
 run('grade(3);grade(3)');assert.equal(run('practicePool.size'),0);
 assert.equal(run('current()'),undefined);
 assert.equal(run('JSON.stringify(phrases)===original'),true);
});
test('practice avoids immediate repeats and skips stable easy phrases',()=>{
 const run=app();run('phrases[0].easyStreak=3;practiceOnly=true;resetReview();globalThis.previous=current().id;grade(0)');
 assert.equal(run('current().id!==previous'),true);
 assert.equal(run('practicePool.has(phrases[0].id)'),false);
});
test('scheduled grades retain minute, ten minute, and day intervals',()=>{
 const run=app();
 for(const [grade,delay] of [[0,60000],[1,600000],[2,86400000],[3,259200000]]){
   assert.equal(run(`(()=>{let p=normalize({});let now=Date.now();schedule(p,${grade});return Math.abs(p.due-now-${delay})<100})()`),true);
 }
 run('let p=normalize({});schedule(p,3);schedule(p,3);schedule(p,3)');assert.equal(run('p.easyStreak'),3);
 run('schedule(p,1)');assert.equal(run('p.easyStreak'),0);
});
test('notifications aggregate overdue deadlines and do not repeat delivered ones',()=>{
 assert.deepEqual(pendingDue([100,200,300],[100],250),[200]);
 assert.deepEqual(pendingDue([100,200,300],[100,200],350),[300]);
});
test('push endpoints reject local and arbitrary hosts',()=>{
 const sub=endpoint=>({endpoint,keys:{auth:'abc',p256dh:'xyz'}});
 assert.equal(validSubscription(sub('https://fcm.googleapis.com/fcm/send/token')),true);
 for(const url of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://example.com/x'])assert.equal(validSubscription(sub(url)),false);
});
