'use strict';
// Only subscription details and due timestamps leave the device.
let reminderConfig = null;
let reminderSync = Promise.resolve();
let reminderRetry = null;
let remindersBusy = false;
const reviewClientId = crypto.randomUUID();
let reviewActivitySequence = 0;
let reminderServer = localStorage.getItem('italiano_push_server') ?? window.ITALIANO_PUSH_SERVER ?? '';
$('notificationServer').value = reminderServer;

function reminderBase(value = reminderServer) {
  if (!value.trim()) return new URL('./', location.href).href;
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Укажите HTTPS-адрес сервера без пути, параметров и пароля.');
  }
  return url.href;
}
function reminderToken() {
  const key = 'italiano_push_token:' + reminderBase();
  let token = localStorage.getItem(key);
  if (!token) {
    // Preserve the existing same-origin server record when upgrading the app.
    token = (!reminderServer && localStorage.getItem('italiano_push_token')) || crypto.randomUUID() + crypto.randomUUID();
    localStorage.setItem(key, token);
  }
  return token;
}
async function reminderRequest(path, method = 'GET', body, keepalive = false) {
  const response = await fetch(new URL('api/' + path, reminderBase()), {
    method,
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + reminderToken()},
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    keepalive,
  });
  if (!response.ok) throw Error(response.status === 429 ? 'Подождите минуту перед следующей проверкой.' : 'Ошибка сервера: HTTP ' + response.status);
  return response.json();
}
async function reminderRegistration() {
  let timeout;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Не удалось запустить приложение для уведомлений. Откройте его заново с подключённым интернетом.')), 10000); }),
  ]).finally(() => clearTimeout(timeout));
}
function reminderEnabled() { return localStorage.getItem('italiano_push_enabled') === '1'; }
function reminderButtons() {
  $('disableNotifications').classList.toggle('hidden', !reminderEnabled());
  $('testNotifications').classList.toggle('hidden', !reminderEnabled() || !reminderConfig?.testSupported);
}
function subscriptionBody(subscription) {
  return {
    subscription: {...subscription.toJSON(), applicationServerKey: reminderConfig.publicKey},
    dues: phrases.map(p => p.due).filter(d => d > 0),
    ...(reminderConfig.activitySupported ? {activity: reviewActivity()} : {}),
  };
}
function reviewActivity() {
  return {clientId: reviewClientId, sequence: ++reviewActivitySequence, active: reviewIsActive()};
}
async function clearReviewNotifications() {
  if (!reviewIsActive() || !('serviceWorker' in navigator)) return;
  try {
    const registration = await reminderRegistration();
    if (!reviewIsActive() || !registration.getNotifications) return;
    for (const notification of await registration.getNotifications({tag: 'italiano-review'})) notification.close();
  } catch {}
}
function updateReviewActivity(leaving = false) {
  clearReviewNotifications();
  if (!reminderEnabled() || !reminderConfig?.activitySupported) return;
  const activity = reviewActivity();
  if (leaving) activity.active = false;
  // Send immediately, including when the page is being hidden. Sequence
  // numbers prevent late requests from overriding a more recent transition.
  return reminderRequest('activity', 'POST', activity, true).catch(() => {});
}
function syncReminders() {
  if (!reminderEnabled() || remindersBusy || !reminderConfig) return;
  clearTimeout(reminderRetry);
  reminderSync = reminderSync.catch(() => {}).then(async () => {
    if (!reminderEnabled() || remindersBusy) return;
    const registration = await reminderRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) throw Error('Подписка недоступна. Включите уведомления заново.');
    await reminderRequest('reminders', 'PUT', subscriptionBody(subscription));
    $('notificationStatus').textContent = 'Напоминания включены. Расписание синхронизировано.';
  }).catch(error => {
    $('notificationStatus').textContent = 'Расписание пока не обновлено. ' + error.message + ' Повторим при подключении.';
    if (reminderEnabled()) reminderRetry = setTimeout(syncReminders, 30000);
  });
}
async function initReminders() {
  $('enableNotifications').disabled = true;
  reminderConfig = null;
  reminderButtons();
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    $('notificationStatus').textContent = 'Push-уведомления недоступны в этом браузере. На iPhone откройте приложение с главного экрана.';
    return;
  }
  if (!reminderServer && location.hostname.endsWith('.github.io')) {
    $('notificationConnection').open = true;
    $('notificationStatus').textContent = 'Подключите сервер напоминаний: вставьте выше адрес вашего Cloudflare Worker. GitHub Pages сам уведомления не отправляет.';
    return;
  }
  try {
    const config = await reminderRequest('push-config');
    if (!config.publicKey) throw Error('Сервер не вернул ключ уведомлений.');
    reminderConfig = config;
    $('enableNotifications').disabled = false;
    $('notificationStatus').textContent = Notification.permission === 'denied'
      ? 'Уведомления запрещены. Разрешите их в настройках браузера.'
      : 'Сервер подключён. Включите напоминания, чтобы получать их при закрытом приложении.';
    reminderButtons();
    syncReminders();
    clearReviewNotifications();
  } catch (error) {
    $('notificationConnection').open = true;
    $('notificationStatus').textContent = 'Сервер напоминаний недоступен. Проверьте адрес и подключение к интернету. ' + error.message;
  }
}
async function disableReminders() {
  clearTimeout(reminderRetry);
  await reminderSync.catch(() => {});
  await reminderRequest('reminders', 'DELETE', {});
  const registration = await reminderRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  localStorage.removeItem('italiano_push_enabled');
  reminderButtons();
}
function notificationBusy(busy) {
  remindersBusy = busy;
  for (const id of ['enableNotifications', 'disableNotifications', 'testNotifications', 'saveNotificationServer']) $(id).disabled = busy;
  if (!busy) $('enableNotifications').disabled = !reminderConfig;
}
$('enableNotifications').onclick = async () => {
  // Request directly from the tap, before any network or service worker wait.
  const permission = Notification.requestPermission();
  notificationBusy(true);
  try {
    if (await permission !== 'granted') throw Error('Разрешите уведомления в настройках браузера.');
    const registration = await reminderRegistration();
    const key = Uint8Array.from(atob(reminderConfig.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const existing = new Uint8Array(subscription.options.applicationServerKey || []);
      if (existing.length !== key.length || existing.some((byte, index) => byte !== key[index])) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    subscription ||= await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
    await reminderRequest('reminders', 'PUT', subscriptionBody(subscription));
    localStorage.setItem('italiano_push_enabled', '1');
    $('notificationStatus').textContent = 'Напоминания включены.';
    reminderButtons();
  } catch (error) { $('notificationStatus').textContent = 'Не удалось включить напоминания. ' + error.message; }
  finally { notificationBusy(false); if (reminderEnabled()) syncReminders(); }
};
$('disableNotifications').onclick = async () => {
  notificationBusy(true);
  try { await disableReminders(); $('notificationStatus').textContent = 'Напоминания отключены.'; }
  catch (error) { $('notificationStatus').textContent = 'Не удалось отключить напоминания. ' + error.message; }
  finally { notificationBusy(false); }
};
$('testNotifications').onclick = async () => {
  notificationBusy(true);
  try {
    await reminderSync.catch(() => {});
    await reminderRequest('test', 'POST', {});
    $('notificationStatus').textContent = 'Проверка запланирована через 10 секунд. Закройте приложение и дождитесь уведомления.';
  } catch (error) { $('notificationStatus').textContent = 'Не удалось отправить проверку. ' + error.message; }
  finally { notificationBusy(false); }
};
$('saveNotificationServer').onclick = async () => {
  const value = $('notificationServer').value.trim();
  notificationBusy(true);
  try {
    reminderBase(value);
    if (reminderEnabled()) await disableReminders();
    reminderServer = value;
    localStorage.setItem('italiano_push_server', value);
    await initReminders();
  } catch (error) { $('notificationStatus').textContent = 'Не удалось подключить сервер. ' + error.message; }
  finally { notificationBusy(false); }
};
window.addEventListener('online', () => reminderConfig ? syncReminders() : initReminders());
document.addEventListener('visibilitychange', () => {
  updateReviewActivity();
  if (document.visibilityState === 'visible') reminderConfig ? syncReminders() : initReminders();
});
window.addEventListener('pagehide', () => updateReviewActivity(true));
setInterval(() => { if (reviewIsActive()) updateReviewActivity(); }, 15000);
window.addEventListener('load', initReminders);
