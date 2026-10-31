import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('Cloudflare runtime persists device keys and executes alarms without an open app', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'italiano-worker-'));
  let runtime;
  let delivery;
  let delivered = 0;
  const received = new Promise(resolve => { delivery = resolve; });
  const origin = 'https://kirillmyasoedov.github.io';
  const headers = {Origin: origin, Authorization: 'Bearer ' + 'b'.repeat(72), 'Content-Type': 'application/json'};
  const options = {
    compatibilityDate: '2026-10-25',
    modulesRoot: fileURLToPath(new URL('..', import.meta.url)),
    modules: ['cloudflare/worker.js', 'cloudflare/push.js', 'reminder-schedule.js', 'review-activity.js'].map(path => ({type: 'ESModule', path: fileURLToPath(new URL('../' + path, import.meta.url))})),
    durableObjects: {REMINDERS: {className: 'ReminderDevice', useSQLite: true}},
    resourcePersistencePath: directory,
    bindings: {ALLOWED_ORIGIN: origin},
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'fcm.googleapis.com');
      assert.equal(request.method, 'POST');
      assert.match(request.headers.get('Authorization'), /^vapid t=/);
      delivered++;
      delivery();
      return new Response(null, {status: 201});
    },
  };
  try {
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    const config = await (await runtime.dispatchFetch('https://worker.test/api/push-config', {headers})).json();
    assert.ok(config.publicKey);
    assert.equal(config.testSupported, true);
    const subscription = {endpoint: 'https://fcm.googleapis.com/fcm/send/runtime-test', keys: {auth: 'auth', p256dh: 'key'}, applicationServerKey: config.publicKey};
    const body = JSON.stringify({subscription, dues: [Date.now() - 1, Date.now() + 600000], activity: {clientId: 'runtime-tab',sequence:1,active:true}});
    const update = await runtime.dispatchFetch('https://worker.test/api/reminders', {method: 'PUT', headers, body});
    assert.equal(update.status, 200);
    assert.equal(update.headers.get('Access-Control-Allow-Origin'), origin);
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(delivered,0,'an open review must suppress the alarm');
    const leave=await runtime.dispatchFetch('https://worker.test/api/activity',{method:'POST',headers,body:JSON.stringify({clientId:'runtime-tab',sequence:2,active:false})});
    assert.equal(leave.status,200);
    let timeout;
    try { await Promise.race([received, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Alarm did not fire')), 15000); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(delivered, 1);
    // Ensure the record write following the network response has completed.
    await runtime.dispatchFetch('https://worker.test/api/reminders', {method: 'PUT', headers, body});
    await runtime.dispose();
    runtime = new Miniflare(convertV4MiniflareOptions(options));
    const reopened = await (await runtime.dispatchFetch('https://worker.test/api/push-config', {headers})).json();
    assert.equal(reopened.publicKey, config.publicKey);
    assert.equal((await runtime.dispatchFetch('https://worker.test/api/reminders', {method: 'PUT', headers, body})).status, 200);
    assert.equal(delivered, 1);
    assert.equal((await runtime.dispatchFetch('https://worker.test/api/reminders', {method: 'DELETE', headers})).status, 200);
  } finally {
    if (runtime) await runtime.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});
