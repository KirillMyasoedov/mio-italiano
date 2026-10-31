import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('a received push refreshes every open app and notification click opens the shared review queue',async()=>{
 const handlers=new Map(),shown=[],messages=[];
 let focused=0;
 const scope='https://example.test/mio-italiano/';
 const clients=[{url:scope,postMessage:message=>messages.push(message.type),focus:async()=>{focused++}},
 {url:scope+'#review',postMessage:message=>messages.push(message.type)},
 {url:'https://example.test/other/',postMessage:()=>{throw Error('Unrelated app')}}];
 const self={registration:{scope,showNotification:async(...args)=>shown.push(args)},addEventListener:(name,handler)=>handlers.set(name,handler),clients:{matchAll:async()=>clients}};
 vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{self,URL});
 let pending;
 handlers.get('push')({waitUntil:promise=>{pending=promise}});await pending;
 assert.equal(shown.length,1);
 assert.deepEqual(messages,['REVIEW_DUE','REVIEW_DUE']);
 let closed=false;
 handlers.get('notificationclick')({notification:{close(){closed=true}},waitUntil:promise=>{pending=promise}});await pending;
 assert.equal(closed,true);assert.equal(focused,1);assert.equal(messages.at(-1),'OPEN_REVIEW');
});
