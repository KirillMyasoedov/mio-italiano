import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker, {ReminderDevice} from '../cloudflare/worker.js';
import {generateKeys, pushAuthorization} from '../cloudflare/push.js';

const origin = 'https://kirillmyasoedov.github.io';
function device() {
  const values = new Map();
  let alarm = null;
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const storage = {
    async get(key) { return Array.isArray(key) ? new Map(key.filter(k => values.has(k)).map(k => [k, clone(values.get(k))])) : clone(values.get(key)); },
    async put(key, value) { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) values.set(k, clone(v)); } else values.set(key, clone(value)); },
    async delete(key) { for (const k of Array.isArray(key) ? key : [key]) values.delete(k); },
    async setAlarm(time) { alarm = time; },
    async deleteAlarm() { alarm = null; },
  };
  const object = new ReminderDevice({storage, blockConcurrencyWhile: task => task()}, {ALLOWED_ORIGIN: origin});
  const call = (path, method = 'GET', body) => object.fetch(new Request('https://worker.test/api/' + path, {method, body: body === undefined ? undefined : JSON.stringify(body)}));
  return {object, call, storage, get alarm() { return alarm; }};
}
async function setup() {
  const state = device();
  const {publicKey} = await (await state.call('push-config')).json();
  const subscription = {endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: {auth: 'auth', p256dh: 'key'}, applicationServerKey: publicKey};
  return {...state, state, subscription};
}

test('VAPID JWT signature is verifiable and restricted to push service origin', async () => {
  const keys = await generateKeys();
  const header = await pushAuthorization('https://fcm.googleapis.com/fcm/send/test', keys, origin, 1800000000000);
  const token = header.match(/t=([^,]+)/)[1];
  const [part1, part2, signature] = token.split('.');
  const decode = text => Buffer.from(text, 'base64url');
  const claims = JSON.parse(decode(part2));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, origin);
  assert.equal(claims.exp, 1800000000 + 43200);
  const publicKey = await crypto.subtle.importKey('raw', decode(keys.publicKey), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
  assert.equal(await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, publicKey, decode(signature), new TextEncoder().encode(part1 + '.' + part2)), true);
});

test('Worker allows Pages CORS preflight, protects origins and hashes device tokens', async () => {
  let name;
  const env = {ALLOWED_ORIGIN: origin, REMINDERS: {idFromName: value => { name = value; return value; }, get: () => ({fetch: () => Response.json({ok: true})})}};
  const path = 'https://worker.test/api/reminders';
  const preflight = await worker.fetch(new Request(path, {method: 'OPTIONS', headers: {Origin: origin}}), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal((await worker.fetch(new Request(path, {headers: {Origin: 'https://evil.test'}}), env)).status, 403);
  assert.equal((await worker.fetch(new Request(path, {method: 'PUT', headers: {Origin: origin}}), env)).status, 401);
  const result = await worker.fetch(new Request(path, {method: 'DELETE', headers: {Origin: origin, Authorization: 'Bearer ' + 'a'.repeat(72)}}), env);
  assert.equal(result.status, 200);
  assert.equal(name.length, 64);
  assert.notEqual(name, 'a'.repeat(64));
  assert.equal((await worker.fetch(new Request(path, {method: 'PUT', headers: {Origin: origin, Authorization: 'Bearer ' + 'a'.repeat(72), 'Content-Type': 'application/json'}, body: 'x'.repeat(250001)}), env)).status, 413);
});

test('alarm sends one push for overdue phrases and preserves later deadlines', async t => {
  const {object, call, state, subscription} = await setup();
  const now = Date.now();
  const dues = [now - 1000, now - 500, now + 600000];
  assert.equal((await call('reminders', 'PUT', {subscription, dues})).status, 200);
  assert.ok(state.alarm <= Date.now() + 1100);
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { requests.push({url, options}); return new Response(null, {status: 201}); };
  t.after(() => { globalThis.fetch = original; });
  await object.alarm();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.match(requests[0].options.headers.Authorization, /^vapid t=/);
  assert.equal(state.alarm, dues[2]);
  // Reopening or synchronizing the unchanged schedule must not repeat old pushes.
  await call('reminders', 'PUT', {subscription, dues});
  await object.alarm();
  assert.equal(requests.length, 1);
  assert.equal(state.alarm, dues[2]);
});

test('updated and deleted schedules cancel stale alarms; key survives disabling', async () => {
  const {call, object, state, subscription} = await setup();
  const first = Date.now() + 60000;
  await call('reminders', 'PUT', {subscription, dues: [first]});
  assert.equal(state.alarm, first);
  const second = first + 540000;
  await call('reminders', 'PUT', {subscription, dues: [second]});
  assert.equal(state.alarm, second);
  await call('reminders', 'PUT', {subscription, dues: []});
  assert.equal(state.alarm, null);
  await call('reminders', 'DELETE');
  assert.equal(await state.storage.get('record'), undefined);
  assert.equal(state.alarm, null);
  assert.equal((await (await call('push-config')).json()).publicKey, subscription.applicationServerKey);
  await object.alarm();
});

test('test notification survives schedule sync and temporary push failure retries', async t => {
  const {call, object, state, subscription} = await setup();
  await call('reminders', 'PUT', {subscription, dues: []});
  assert.equal((await call('test', 'POST', {})).status, 200);
  assert.equal((await call('test', 'POST', {})).status, 429);
  await call('reminders', 'PUT', {subscription, dues: [Date.now() + 86400000]});
  const record = await state.storage.get('record');
  assert.ok(record.testDue);
  record.testDue = Date.now() - 1;
  await state.storage.put('record', record);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {status: 503});
  t.after(() => { globalThis.fetch = original; });
  await object.alarm();
  assert.equal((await state.storage.get('record')).failures, 1);
  assert.ok(state.alarm > Date.now() + 29000);
  globalThis.fetch = async () => new Response(null, {status: 201});
  await object.alarm();
  assert.equal((await state.storage.get('record')).testDue, undefined);
  assert.ok(state.alarm > Date.now() + 86000000);
});

test('expired subscriptions stop alarms; invalid subscriptions are rejected', async t => {
  const {call, object, state, subscription} = await setup();
  assert.equal((await call('reminders', 'PUT', {subscription: {...subscription, applicationServerKey: 'wrong'}, dues: [1]})).status, 400);
  assert.equal((await call('reminders', 'PUT', {subscription: {...subscription, endpoint: 'https://127.0.0.1'}, dues: [1]})).status, 400);
  await call('reminders', 'PUT', {subscription, dues: [1]});
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {status: 410});
  t.after(() => { globalThis.fetch = original; });
  await object.alarm();
  assert.equal(await state.storage.get('record'), undefined);
  assert.equal(state.alarm, null);
});

test('large dictionaries keep pending and delivered timestamps in bounded chunks', async t => {
  const {call, object, state, subscription} = await setup();
  const dues = Array.from({length: 10000}, (_, i) => Date.now() - 20000 + i);
  await call('reminders', 'PUT', {subscription, dues});
  assert.equal((await state.storage.get('schedule-a')).length, 5000);
  assert.equal((await state.storage.get('schedule-b')).length, 5000);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {status: 201});
  t.after(() => { globalThis.fetch = original; });
  await object.alarm();
  assert.equal((await state.storage.get('delivered-a')).length, 5000);
  assert.equal((await state.storage.get('delivered-b')).length, 5000);
  await call('reminders', 'PUT', {subscription, dues});
  assert.deepEqual(await object.parts('schedule'), []);
  assert.equal(state.alarm, null);
});

test('active review defers all deadlines, then groups overdue phrases after leaving', async t => {
  const {object,call,state,subscription}=await setup();
  const now=Date.now(),dues=[now-1000,now-500,now+600000];
  const activity={clientId:'tab-a',sequence:1,active:true};
  assert.equal((await call('reminders','PUT',{subscription,dues,activity})).status,200);
  assert.ok(state.alarm>=now+44000);
  let sent=0;const original=globalThis.fetch;
  globalThis.fetch=async()=>{sent++;return new Response(null,{status:201})};
  t.after(()=>{globalThis.fetch=original});
  await object.alarm();assert.equal(sent,0);
  assert.equal((await object.parts('schedule')).length,3);
  await call('activity','POST',{...activity,sequence:2,active:false});
  // An old full-schedule update cannot renew the previous active lease.
  await call('reminders','PUT',{subscription,dues,activity});
  assert.ok(state.alarm<Date.now()+2000);
  await object.alarm();assert.equal(sent,1);
  assert.deepEqual(await object.parts('schedule'),[dues[2]]);
});

test('closing another tab does not cancel an active review; expired leases resume pushes', async t => {
  const {object,call,state,subscription}=await setup();
  await call('reminders','PUT',{subscription,dues:[1]});
  await call('activity','POST',{clientId:'tab-a',sequence:1,active:true});
  await call('activity','POST',{clientId:'tab-b',sequence:1,active:false});
  let sent=0;const original=globalThis.fetch;
  globalThis.fetch=async()=>{sent++;return new Response(null,{status:201})};
  t.after(()=>{globalThis.fetch=original});
  await object.alarm();assert.equal(sent,0);
  const record=await state.storage.get('record');
  record.reviewClients['tab-a'].until=Date.now()-1;
  await state.storage.put('record',record);
  await object.alarm();assert.equal(sent,1);
  assert.equal(state.alarm,null);
});
