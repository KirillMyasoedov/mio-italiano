// Group all timestamps already due into one notification. Never notify twice
// for the same deadline; later deadlines remain scheduled even if the app closes.
export function pendingDue(dues, delivered, now) {
  return dues.filter(due => due <= now && !delivered.includes(due));
}
export function validSubscription(subscription) {
  try {
    const url = new URL(subscription.endpoint);
    return url.protocol === 'https:' && url.port === '' && (
      url.hostname === 'fcm.googleapis.com' ||
      url.hostname === 'updates.push.services.mozilla.com' ||
      url.hostname.endsWith('.notify.windows.com') ||
      url.hostname.endsWith('.push.apple.com')
    ) && typeof subscription.keys?.auth === 'string' && typeof subscription.keys?.p256dh === 'string';
  } catch { return false; }
}
