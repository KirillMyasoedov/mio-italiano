import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function app(server = '') {
  const values = new Map();
  const elements = new Map();
  const requests = [];
  const timers = new Map();
  let subscription = null;
  let unsubscribed = 0;
  const publicKey = Buffer.from(new Uint8Array(65).fill(1)).toString('base64url');
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value: '', disabled: false, hidden: false, classList: {toggle(name, value) { elements.get(id).hidden = value; }}});
    return elements.get(id);
  };
  const registration = {pushManager: {
    getSubscription: async () => subscription,
    subscribe: async options => {
      subscription = {options: {applicationServerKey: options.applicationServerKey.buffer}, toJSON: () => ({endpoint: 'https://fcm.googleapis.com/test', keys: {auth: 'auth', p256dh: 'key'}}), unsubscribe: async () => { unsubscribed++; subscription = null; return true; }};
      return subscription;
    },
  }};
  const context = vm.createContext({
    $: element,
    localStorage: {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
    window: {ITALIANO_PUSH_SERVER: server, addEventListener() {}, Notification: true, PushManager: true},
    Notification: {permission: 'granted', requestPermission: async () => 'granted'},
    document: {addEventListener() {}},
    navigator: {serviceWorker: {ready: Promise.resolve(registration)}},
    location: {href: 'https://kirillmyasoedov.github.io/mio-italiano/', hostname: 'kirillmyasoedov.github.io'},
    URL, crypto, atob, AbortSignal, console,
    setTimeout: (task, ms) => { const id = Math.random(); timers.set(id, {task, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    phrases: [{due: 100}, {due: 0}],
    fetch: async (url, options) => { requests.push({url: String(url), options}); return Response.json(String(url).endsWith('push-config') ? {publicKey, testSupported: true} : {}); },
  });
  vm.runInContext(readFileSync(new URL('../reminders.js', import.meta.url), 'utf8'), context);
  return {run: code => vm.runInContext(code, context), values, requests, elements, timers, get unsubscribed() { return unsubscribed; }};
}

test('GitHub Pages with no backend gives connection instructions instead of querying a nonexistent API', async () => {
  const {run, requests, elements} = app();
  await run('initReminders()');
  assert.equal(requests.length, 0);
  assert.equal(elements.get('enableNotifications').disabled, true);
  assert.match(elements.get('notificationStatus').textContent, /Cloudflare Worker/);
});

test('Pages app subscribes and syncs to a separate HTTPS Worker, then deletes the subscription', async () => {
  const state = app('https://italiano.example.workers.dev');
  const {run, requests, elements, values} = state;
  await run('initReminders()');
  assert.equal(requests[0].url, 'https://italiano.example.workers.dev/api/push-config');
  assert.match(requests[0].options.headers.Authorization, /^Bearer /);
  await elements.get('enableNotifications').onclick();
  await run('reminderSync');
  assert.equal(values.get('italiano_push_enabled'), '1');
  let body = JSON.parse(requests.find(request => request.options.method === 'PUT').options.body);
  assert.deepEqual(body.dues, [100]);
  assert.ok(body.subscription.applicationServerKey);
  assert.equal(elements.get('testNotifications').hidden, false);
  run('phrases[0].due=200;syncReminders()');
  await run('reminderSync');
  body = JSON.parse(requests.at(-1).options.body);
  assert.deepEqual(body.dues, [200]);
  await elements.get('testNotifications').onclick();
  assert.equal(requests.at(-1).url, 'https://italiano.example.workers.dev/api/test');
  await elements.get('disableNotifications').onclick();
  assert.equal(requests.at(-1).options.method, 'DELETE');
  assert.equal(values.has('italiano_push_enabled'), false);
  assert.equal(state.unsubscribed, 1);
});

test('server address requires HTTPS without credentials, path or query; local server still works', async () => {
  const {run, requests} = app();
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?token=x']) {
    assert.throws(() => run(`reminderBase(${JSON.stringify(value)})`));
  }
  run("location.href='http://localhost:3000/';location.hostname='localhost'");
  await run('initReminders()');
  assert.equal(requests[0].url, 'http://localhost:3000/api/push-config');
});

test('a failed schedule sync retries while preserving enabled state', async () => {
  const {run, elements, values, timers} = app('https://italiano.example.workers.dev');
  await run('initReminders()');
  await elements.get('enableNotifications').onclick();
  await run('reminderSync');
  run("fetch=async()=>{throw Error('Offline')};syncReminders()");
  await run('reminderSync');
  assert.equal(values.get('italiano_push_enabled'), '1');
  assert.equal([...timers.values()].some(timer => timer.ms === 30000), true);
  assert.match(elements.get('notificationStatus').textContent, /пока не обновлено/);
});
