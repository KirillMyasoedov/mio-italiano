import {validSubscription, pendingDue} from '../reminder-schedule.js';
import {generateKeys, matchesKey, sendPush} from './push.js';

const json = (value, status = 200) => Response.json(value, {status, headers: {'Cache-Control': 'no-store'}});
const MAX_BODY = 250000;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN;
    if (origin && !allowed) return json({error: 'Origin not allowed'}, 403);
    const cors = allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    } : {};
    const finish = response => {
      const result = new Response(response.body, response);
      for (const [key, value] of Object.entries(cors)) result.headers.set(key, value);
      return result;
    };
    if (!['/api/push-config', '/api/reminders', '/api/test'].includes(path)) return finish(json({error: 'Not found'}, 404));
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    const token = request.headers.get('Authorization')?.match(/^Bearer ([a-zA-Z0-9-]{64,100})$/)?.[1];
    if (!token) return finish(json({error: 'Device token required'}, 401));
    if ((path === '/api/push-config' && request.method !== 'GET') ||
        (path === '/api/reminders' && !['PUT', 'DELETE'].includes(request.method)) ||
        (path === '/api/test' && request.method !== 'POST')) return finish(json({error: 'Method not allowed'}, 405));
    if (['PUT', 'POST'].includes(request.method)) {
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return finish(json({error: 'JSON required'}, 415));
      // Bound the stream as well as Content-Length, which is not always sent.
      let size = 0;
      const reader = request.body?.getReader();
      const chunks = [];
      if (reader) {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) { await reader.cancel(); return finish(json({error: 'Request too large'}, 413)); }
          chunks.push(value);
        }
      }
      request = new Request(request.url, {method: request.method, headers: request.headers, body: new Blob(chunks)});
    }
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const id = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    try {
      return finish(await env.REMINDERS.get(env.REMINDERS.idFromName(id)).fetch(request));
    } catch {
      return finish(json({error: 'Reminder service temporarily unavailable'}, 503));
    }
  },
};

// One persistent object and one next-deadline alarm per device. Nothing polls
// while there is no pending work. SQLite-backed objects work on Workers Free.
export class ReminderDevice {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;
      if (path === '/api/push-config') {
        let keys = await this.ctx.storage.get('keys');
        if (!keys) { keys = await generateKeys(); await this.ctx.storage.put('keys', keys); }
        return json({publicKey: keys.publicKey, testSupported: true});
      }
      if (request.method === 'DELETE') {
        // Keep the VAPID key so re-enabling doesn't require a new browser key.
        await this.ctx.storage.delete(['record', 'schedule-a', 'schedule-b', 'delivered-a', 'delivered-b']);
        await this.ctx.storage.deleteAlarm();
        return json({});
      }
      let input;
      try { input = await request.json(); } catch { return json({error: 'Invalid JSON'}, 400); }
      let record = await this.ctx.storage.get('record');
      if (path === '/api/test') {
        if (!record?.subscription) return json({error: 'Enable notifications first'}, 409);
        if (record.testRequestedAt && Date.now() - record.testRequestedAt < 60000) return json({error: 'Wait a minute before another test'}, 429);
        record.testRequestedAt = Date.now();
        record.testDue = Date.now() + 10000;
        await this.ctx.storage.put('record', record);
        await this.setNextAlarm(record);
        return json({});
      }
      const {subscription, dues} = input;
      const keys = await this.ctx.storage.get('keys');
      if (!validSubscription(subscription) || !keys || !matchesKey(subscription, keys) ||
          !Array.isArray(dues) || dues.length > 10000 || !dues.every(d => Number.isSafeInteger(d) && d > 0)) {
        return json({error: 'Invalid subscription or schedule'}, 400);
      }
      const delivered = new Set(await this.parts('delivered'));
      // Already delivered deadlines stay acknowledged while present in the
      // schedule. Store chunks below the storage API's per-value size limit.
      const unique = [...new Set(dues)].sort((a, b) => a - b);
      record = {...record, subscription, failures: 0};
      const acknowledged = unique.filter(d => delivered.has(d));
      const schedule = unique.filter(d => !delivered.has(d));
      await this.ctx.storage.put({record, 'schedule-a': schedule.slice(0, 5000), 'schedule-b': schedule.slice(5000),
        'delivered-a': acknowledged.slice(0, 5000), 'delivered-b': acknowledged.slice(5000)});
      await this.setNextAlarm(record, schedule);
      return json({});
    });
  }

  async parts(prefix) {
    const parts = await this.ctx.storage.get([prefix + '-a', prefix + '-b']);
    return [...(parts.get(prefix + '-a') || []), ...(parts.get(prefix + '-b') || [])];
  }

  async setNextAlarm(record, schedule) {
    schedule ??= await this.parts('schedule');
    const next = Math.min(...schedule, record.testDue || Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    // Serialize schedule replacement with delivery, including the network wait.
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = await this.ctx.storage.get('record');
      if (!record?.subscription) return;
      const schedule = await this.parts('schedule');
      const now = Date.now();
      const due = pendingDue(schedule, [], now);
      if (!due.length && !(record.testDue && record.testDue <= now)) {
        await this.setNextAlarm(record, schedule);
        return;
      }
      try {
        const keys = await this.ctx.storage.get('keys');
        const response = await sendPush(record.subscription, keys, this.env.ALLOWED_ORIGIN);
        if ([404, 410].includes(response.status)) {
          await this.ctx.storage.delete(['record', 'schedule-a', 'schedule-b', 'delivered-a', 'delivered-b']);
          await this.ctx.storage.deleteAlarm();
          return;
        }
        if (!response.ok) throw Error('Push service rejected request');
      } catch {
        record.failures = (record.failures || 0) + 1;
        await this.ctx.storage.put('record', record);
        await this.ctx.storage.setAlarm(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(record.failures - 1, 7)));
        return;
      }
      record.failures = 0;
      const delivered = [...await this.parts('delivered'), ...due];
      if (record.testDue <= now) delete record.testDue;
      const remaining = schedule.filter(d => d > now);
      await this.ctx.storage.put({record, 'schedule-a': remaining.slice(0, 5000), 'schedule-b': remaining.slice(5000),
        'delivered-a': delivered.slice(0, 5000), 'delivered-b': delivered.slice(5000)});
      await this.setNextAlarm(record, remaining);
    });
  }
}
