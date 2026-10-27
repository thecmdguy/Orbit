// Orbit service worker: Web Push notifications + opening the right screen on tap.
// No offline caching on purpose: Orbit is a live server console, stale pages would mislead.
const VERSION = 'orbit-sw-1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Orbit', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Orbit';
  const opts = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/claude/pwa/icon-192.png',
    badge: '/claude/pwa/icon-192.png',
    data: { url: d.url || '/claude/', kind: d.kind || '' },
    timestamp: d.at || Date.now(),
    requireInteraction: d.kind === 'approval',
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    if (typeof d.badge === 'number' && self.navigator.setAppBadge) {
      try { d.badge > 0 ? await self.navigator.setAppBadge(d.badge) : await self.navigator.clearAppBadge(); } catch {}
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/claude/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all.find((w) => w.url.startsWith(self.location.origin + '/claude'));
    if (c) {
      try { await c.focus(); } catch {}
      c.postMessage({ type: 'orbit:navigate', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'version') e.source?.postMessage({ type: 'version', version: VERSION });
});
