// The notification text lives in sw.js, so Web Push needs no payload or
// encryption keys. VAPID still authenticates every request (RFC 8292).
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function generateKeys() {
  const pair = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = encode(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {privateKey, publicKey};
}

export async function pushAuthorization(endpoint, keys, subject, now = Date.now()) {
  const json = value => encode(new TextEncoder().encode(JSON.stringify(value)));
  const header = json({typ: 'JWT', alg: 'ES256'});
  const claims = json({aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject});
  const unsigned = header + '.' + claims;
  const key = await crypto.subtle.importKey('jwk', keys.privateKey, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${encode(signature)}, k=${keys.publicKey}`;
}

export async function sendPush(subscription, keys, subject, fetcher = fetch) {
  return fetcher(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await pushAuthorization(subscription.endpoint, keys, subject),
      TTL: '3600',
      Urgency: 'high',
      Topic: 'italiano-review',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
}

export function matchesKey(subscription, keys) {
  try {
    // Push subscriptions are bound to this VAPID key by the browser. The
    // supplied applicationServerKey is also checked before replacing a record.
    return subscription.applicationServerKey === keys.publicKey && decode(keys.publicKey).length === 65;
  } catch { return false; }
}
