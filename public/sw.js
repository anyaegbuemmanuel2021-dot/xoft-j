// sw.js — offline APP SHELL only (HTML/CSS/JS so the PWA can launch with no
// network). Deliberately does NOT touch /api/* requests: api.js already
// owns response caching (for reads) and the offline mutation queue (for
// writes) at the application layer, where it can make informed decisions
// per-endpoint. A service-worker-level cache for API calls would just be a
// second, dumber cache fighting the first one.

const CACHE_NAME = 'xoft-shell-v9';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/css/command-center.css',
  '/js/dashboard/ActivityPanel.js',
  '/js/dashboard/ApprovalCard.js',
  '/js/dashboard/BootSequence.js',
  '/js/dashboard/CommandInput.js',
  '/js/dashboard/CurrentTaskPanel.js',
  '/js/dashboard/DashboardNavigation.js',
  '/js/dashboard/MemoryPanel.js',
  '/js/dashboard/ProviderStatusPanel.js',
  '/js/dashboard/StatusIndicator.js',
  '/js/dashboard/SystemLogPanel.js',
  '/js/dashboard/SystemStatusPanel.js',
  '/js/dashboard/TelemetryGraph.js',
  '/js/dashboard/TopBar.js',
  '/js/dashboard/XoftCommandCenter.js',
  '/js/dashboard/XoftCore.js',
  '/js/dashboard/data.js',
  '/js/dashboard/MissionsPanel.js',
  '/js/dashboard/DiagnosticsPanel.js',
  '/js/dashboard/AutonomyPanel.js',
  '/js/dashboard/logic.js',
  '/js/dashboard/store.js',
  '/js/api.js',
  '/js/dom.js',
  '/js/router.js',
  '/js/ws.js',
  '/js/app.js',
  '/js/views/overview.js',
  '/js/views/chat.js',
  '/js/views/tasks.js',
  '/js/views/missions.js',
  '/js/views/memory.js',
  '/js/views/devices.js',
  '/js/views/approvals.js',
  '/js/views/automation.js',
  '/js/views/activity.js',
  '/js/views/settings.js',
  '/js/views/integrations.js',
  '/js/views/aiGateways.js',
  '/js/views/runtime.js',
  '/js/views/engines.js',
  '/js/voice/speak-out.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          //if (res.ok)
          const copy = res.clone(); 
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached ?? network;
    })
  );
});
