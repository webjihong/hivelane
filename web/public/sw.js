/* Hivelane 서비스 워커: 웹 푸시만 처리한다(오프라인 캐시 없음). v3 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Hivelane', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Hivelane';
  const full = {
    body: d.body || '',
    tag: d.tag || undefined,
    // 같은 tag 로 갱신돼도 다시 울리게(휴대폰에서 소리·진동)
    renotify: !!d.tag,
    vibrate: [200, 100, 200],
    // 사람 확인 필요·실패는 직접 닫을 때까지 남김
    requireInteraction: d.level === 'crit',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: d.url || '/' },
  };
  e.waitUntil((async () => {
    // 표시 옵션을 못 받아들이는 기기도 있어 실패하면 최소 옵션으로 다시 띄운다
    let shown = 'full';
    try { await self.registration.showNotification(title, full); }
    catch (err) {
      shown = 'basic: ' + (err && err.message);
      await self.registration.showNotification(title, { body: full.body, data: full.data });
    }
    // 열려 있는 화면에 「도착」을 알린다(설정 › 알림 점검용)
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: 'hl-push', title, shown }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const raw = (e.notification.data && e.notification.data.url) || '/';
  const url = new URL(raw, self.location.origin).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(url); } catch { /* 다른 문서면 무시 */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
