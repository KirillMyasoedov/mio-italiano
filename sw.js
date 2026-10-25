const CACHE='italiano-pwa-v3';
const ASSETS=['./','./index.html','./app.js','./reminders.js','./push-config.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname.includes('/api/'))return;if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)))});

self.addEventListener('push',event=>{event.waitUntil(self.registration.showNotification('Пора повторить итальянский 🇮🇹',{body:'Есть фразы, которые пора повторить. Откройте разговорник.',icon:'./icons/icon-192.png',tag:'italiano-review',data:{url:new URL('./#review',self.registration.scope).href}}))});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const url=new URL('./#review',self.registration.scope).href;const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});let client=windows.find(c=>c.url.startsWith(self.registration.scope));if(client){await client.focus();client.postMessage({type:'OPEN_REVIEW'})}else await self.clients.openWindow(url)})())});
