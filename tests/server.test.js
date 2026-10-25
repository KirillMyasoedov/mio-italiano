import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
test('server persists subscriptions, protects APIs, and serves app',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'italiano-test-'));
 let child;
 async function start(){child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'31987',DATA_DIR:directory},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited')})])}
 async function stop(){const exit=once(child,'exit');child.kill();await exit}
 const base='http://127.0.0.1:31987';
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+'a'.repeat(72)};
 try{
  await start();
  assert.equal((await fetch(base)).status,200);
  const config=await (await fetch(base+'/api/push-config')).json();assert.ok(config.publicKey);
  assert.equal((await fetch(base+'/api/reminders',{method:'PUT'})).status,401);
  const body=JSON.stringify({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{auth:'abc',p256dh:'def'}},dues:[Date.now()+86400000]});
  assert.equal((await fetch(base+'/api/reminders',{method:'PUT',headers,body})).status,200);
  assert.equal((await fetch(base+'/api/reminders',{method:'PUT',headers:{...headers,'sec-fetch-site':'cross-site'},body})).status,403);
  assert.equal((await fetch(base+'/data/vapid.json')).status,404);
  await stop();await start();
  assert.equal((await (await fetch(base+'/api/push-config')).json()).publicKey,config.publicKey);
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'subscriptions.json')))).length,1);
  assert.equal((await fetch(base+'/api/reminders',{method:'DELETE',headers})).status,200);
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'subscriptions.json')))).length,0);
 }finally{if(child?.exitCode===null)await stop();await rm(directory,{recursive:true,force:true})}
});
