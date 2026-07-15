// sw.js — KILL SWITCH. This site is now a redirect to its canonical home on
// nave.pub. Any previously-installed caching worker is evicted here: purge
// every cache, unregister, and reload controlled pages once — clean, from the
// network. Delivered automatically via the browser's service-worker update
// check, so poisoned tabs self-heal on their next visit.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    for (const client of await self.clients.matchAll()) {
      try { client.navigate(client.url) } catch { /* next manual reload is clean */ }
    }
  })())
})
