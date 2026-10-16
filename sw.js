/* Service Worker — Cronograma Acadêmico 23B
   1) Cache do "casco" do app (abre rápido e abre offline com a última versão).
   2) Push em segundo plano (Firebase Cloud Messaging), mesmo com o app fechado.
   Dados (Firestore, Auth, Google Fonts etc.) NUNCA são cacheados aqui. */
const VERSION = 'v1';
const CACHE = 'cronograma-' + VERSION;
const SHELL = ['./', 'index.html', 'manifest.json', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('cronograma-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Navegação: rede primeiro (sempre a versão mais nova), cache se estiver offline.
// Arquivos estáticos do próprio site: cache primeiro, atualiza em segundo plano.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/.netlify/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('index.html', c)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const rede = fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; }).catch(() => hit);
    return hit || rede;
  }));
});

// ---------- Push (FCM, mensagens só com "data") ----------
self.addEventListener('push', e => {
  let p = {};
  try { const j = e.data ? e.data.json() : {}; p = j.data || j.notification || j; } catch (_) {}
  const titulo = p.titulo || p.title || 'Cronograma Acadêmico';
  const opts = {
    body: p.corpo || p.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: p.tag || p.refId || undefined,   // mesma tag = substitui em vez de empilhar
    renotify: !!p.tag,
    data: { url: p.url || '/', refId: p.refId || '', tipo: p.tipo || '' },
  };
  // App aberto e visível: o próprio app já mostra o aviso (evita notificação em dobro).
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(titulo, opts);
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    for (const c of lista) { if ('focus' in c) { c.focus(); return; } }
    return self.clients.openWindow(alvo);
  }));
});
