// Short leases recover automatically if the app closes without a final request.
export const REVIEW_LEASE_MS = 45000;

export function applyReviewActivity(record, activity, now = Date.now()) {
  if (!activity || typeof activity.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(activity.clientId) ||
      typeof activity.active !== 'boolean' || !Number.isSafeInteger(activity.sequence) || activity.sequence < 1) return false;
  const clients = Object.fromEntries(Object.entries(record.reviewClients || {}).filter(([, value]) => value.seenAt > now - 300000));
  const previous = clients[activity.clientId];
  // A delayed heartbeat must not reactivate a tab that has already closed.
  if (!previous || previous.sequence < activity.sequence) {
    clients[activity.clientId] = {sequence: activity.sequence, seenAt: now, until: activity.active ? now + REVIEW_LEASE_MS : 0};
  }
  record.reviewClients = Object.fromEntries(Object.entries(clients).sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, 20));
  return true;
}

export function reviewActiveUntil(record) {
  return Math.max(0, ...Object.values(record.reviewClients || {}).map(client => client.until));
}
