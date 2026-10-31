import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {pendingDue,validSubscription} from '../reminder-schedule.js';
function app(){
 const elements=new Map(),events=new Map(),timers=[];
 let now=1800000000000;
 const element=id=>{if(!elements.has(id)){
   const classes=new Set();
   elements.set(id,{value:'',classList:{add(name){classes.add(name)},remove(name){classes.delete(name)},toggle(name,hidden){hidden?classes.add(name):classes.delete(name)},contains:name=>classes.has(name)},replaceChildren(){},append(){},style:{}});
 }return elements.get(id)};
 const tabs=['library','review','manage'].map(id=>({...element('tab-'+id),dataset:{tab:id},click(){this.onclick()}}));
 const listen=(name,handler)=>{const handlers=events.get(name)||[];handlers.push(handler);events.set(name,handlers)};
 const document={visibilityState:'visible',getElementById:element,querySelectorAll:()=>tabs,querySelector:()=>tabs[1],createElement:()=>element(Symbol()),addEventListener:listen};
 const context=vm.createContext({document,Date:class extends Date{static now(){return now}},localStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=>String(Math.random())},window:{addEventListener:listen},navigator:{serviceWorker:{addEventListener:listen}},location:{hash:'',protocol:'https:'},setInterval:callback=>timers.push(callback),setTimeout(){},clearTimeout(){},syncReminders(){},console});
 vm.runInContext(readFileSync(new URL('../app.js',import.meta.url),'utf8'),context);
 const run=code=>vm.runInContext(code,context);
 run.elements=elements;run.advance=ms=>{now+=ms};run.events=events;run.timers=timers;
 return run;
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

test('newly due phrases join the active queue without hiding the current answer',()=>{
 const run=app();
 run("phrases=[normalize({id:'first',due:0}),normalize({id:'later',due:Date.now()+1000})];openReview();$('showAnswer').onclick()");
 assert.equal(run("$('answer').classList.contains('hidden')"),false);
 run.advance(2000);run('refreshReviewQueue()');
 assert.equal(run('reviewIds.length'),2);
 assert.equal(run('current().id'),'first');
 assert.equal(run("$('answer').classList.contains('hidden')"),false);
 assert.equal(run("$('reviewPosition').textContent"),'1 / 2');
 run('grade(2)');assert.equal(run('current().id'),'later');
});
test('forgotten phrases rejoin the queue when their next deadline arrives',()=>{
 const run=app();run("phrases=[normalize({id:'again',due:0})];openReview();grade(0)");
 assert.equal(run('current()'),undefined);
 run.advance(60001);run.timers[0]();
 assert.equal(run('current().id'),'again');
 run('refreshReviewQueue();refreshReviewQueue()');
 assert.equal(run('reviewIds.slice(reviewIndex).length'),1);
});
test('one notification click exposes all overdue phrases and subsequent pushes preserve the current card',()=>{
 const run=app();run("phrases=[normalize({id:'a',due:0}),normalize({id:'b',due:0})]");
 const message=run.events.get('message')[0];message({data:{type:'OPEN_REVIEW'}});
 assert.equal(run('reviewIds.length'),2);
 run("$('showAnswer').onclick()");
 run("phrases.push(normalize({id:'c',due:0}))");message({data:{type:'REVIEW_DUE'}});
 assert.equal(run('reviewIds.length'),3);
 message({data:{type:'OPEN_REVIEW'}});
 assert.equal(run("$('answer').classList.contains('hidden')"),false);
 assert.equal(run('current().id'),'a');
});
test('background return refreshes due phrases and practice sessions keep their own queue',()=>{
 const run=app();run("phrases=[normalize({id:'a',due:Date.now()+1000})];openReview()");
 run.advance(2000);run.events.get('visibilitychange')[0]();assert.equal(run('current().id'),'a');
 run('practiceOnly=true;resetReview();globalThis.original=JSON.stringify(reviewIds);phrases.push(normalize({id:"b",due:0}));refreshReviewQueue()');
 assert.equal(run('JSON.stringify(reviewIds)===original'),true);
 assert.equal(run('reviewIsActive()'),true);
 run("document.visibilityState='hidden'");assert.equal(run('reviewIsActive()'),false);
});
