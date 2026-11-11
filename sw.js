// Wanted — service worker : affiche les notifications web, même téléphone verrouillé.
// Pas de cache hors ligne : le jeu a besoin du serveur en permanence.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; }
  catch (e) { p = { title: "Wanted", body: event.data ? event.data.text() : "" }; }

  const urgent = !!p.urgent;
  const options = {
    body: p.body || "",
    tag: p.tag || "wanted",
    renotify: true,
    icon: "assets/icon-192.png",
    badge: "assets/icon-192.png",
    // Alerte « Wanted ! » et pings : vibration longue et notification qui reste affichée.
    vibrate: urgent ? [400, 150, 400, 150, 400, 150, 800] : [200, 100, 200],
    requireInteraction: urgent,
    timestamp: Date.now(),
    data: { url: p.url || "./", kind: p.kind || "" }
  };
  event.waitUntil(self.registration.showNotification(p.title || "Wanted", options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope) && !w.url.includes("org.html") && "focus" in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
