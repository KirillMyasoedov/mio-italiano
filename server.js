import http from 'node:http';
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {createHash} from 'node:crypto';
import webpush from 'web-push';
import {pendingDue, validSubscription} from './reminder-schedule.js';

const root = new URL('.', import.meta.url);
const directory = resolve(process.env.DATA_DIR || './data');
await mkdir(directory, {recursive:true, mode:0o700});
const load = async (name, fallback) => {try {return JSON.parse(await readFile(resolve(directory,name),'utf8'))} catch(error) {if(error.code !== 'ENOENT')throw error;return fallback}};
let keys = await load('vapid.json', null);
if (!keys) {
  keys = webpush.generateVAPIDKeys();
  await writeFile(resolve(directory,'vapid.json'), JSON.stringify(keys), {mode:0o600});
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
const records = await load('subscriptions.json', {});
let writing = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(records);
  writing = writing.catch(()=>{}).then(async()=>{
    await writeFile(resolve(directory,'subscriptions.tmp'), snapshot, {mode:0o600});
    await rename(resolve(directory,'subscriptions.tmp'),resolve(directory,'subscriptions.json'));
  });
  return writing;
}
const assets = new Set(['index.html','app.js','sw.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png']);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'};
const server = http.createServer(async (request,response)=>{
  const send = (status,body) => {response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(body))};
  try {
    const path = new URL(request.url,'http://localhost').pathname;
    if(path === '/api/push-config' && request.method === 'GET')return send(200,{publicKey:keys.publicKey});
    if(path === '/api/reminders') {
      // Same-origin JSON requests only; tokens grant access to one device record.
      if(request.headers['sec-fetch-site'] === 'cross-site')return send(403,{});
      const token = request.headers.authorization?.match(/^Bearer ([a-zA-Z0-9-]{64,100})$/)?.[1];
      if(!token)return send(401,{});
      const id = createHash('sha256').update(token).digest('hex');
      if(request.method === 'DELETE'){delete records[id];await persist();return send(200,{})}
      if(request.method !== 'PUT')return send(405,{});
      if(!request.headers['content-type']?.startsWith('application/json'))return send(415,{});
      let body='';
      for await (const chunk of request){body+=chunk;if(Buffer.byteLength(body)>250000)return send(413,{})}
      const {subscription,dues} = JSON.parse(body);
      if(!validSubscription(subscription)||!Array.isArray(dues)||dues.length>10000||!dues.every(d=>Number.isSafeInteger(d)&&d>0))return send(400,{});
      if(!records[id] && Object.keys(records).length>=10000)return send(503,{});
      const delivered = (records[id]?.delivered || []).filter(d=>dues.includes(d));
      records[id]={subscription,dues:[...new Set(dues)],delivered,revision:(records[id]?.revision||0)+1};
      await persist();return send(200,{});
    }
    if(request.method!=='GET')return send(405,{});
    const asset=path==='/'?'index.html':path.slice(1);
    if(!assets.has(asset))return send(404,{});
    response.writeHead(200,{'Content-Type':types[extname(asset)],'Cache-Control':'no-cache'});
    response.end(await readFile(new URL(asset,root)));
  }catch(error){console.error('Request failed:',error.message);if(!response.headersSent)send(400,{error:'Request failed'});else response.end()}
});
let ticking=false;
async function tick(){
  if(ticking)return;
  ticking=true;
  try {
    for(const [id,record] of Object.entries(records)) {
      const due=pendingDue(record.dues,record.delivered,Date.now());
      if(!due.length)continue;
      try {
        await webpush.sendNotification(record.subscription,JSON.stringify({type:'review'}),{TTL:3600,urgency:'high',timeout:10000});
        // A schedule update may arrive while the push service is responding.
        if(records[id]===record){record.delivered.push(...due);await persist()}
      }catch(error){if([404,410].includes(error.statusCode)&&records[id]===record){delete records[id];await persist()}else console.error('Push delivery failed:',error.statusCode||error.code||'unknown')}
    }
  }finally{ticking=false}
}
setInterval(()=>tick().catch(error=>console.error('Scheduler failed:',error.message)),5000).unref();
server.listen(Number(process.env.PORT)||3000,process.env.HOST||'127.0.0.1',()=>console.log('Il mio italiano server ready'));
