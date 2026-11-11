// Carte (Leaflet), périmètre, GPS et signal sonore — partagés par les écrans joueur et organisateur.
(function () {
  const { rpc, fmtTime, esc } = window.W;

  let perimeterPromise = null;
  function loadPerimeter() {
    if (!perimeterPromise) perimeterPromise = rpc("get_perimeter").catch(() => { perimeterPromise = null; return null; });
    return perimeterPromise;
  }

  // Crée une carte dans `el` avec le périmètre ; renvoie { map, layer } où `layer` reçoit les marqueurs.
  function createMap(el) {
    const map = L.map(el, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);
    map.setView(window.W.CFG.MAP_CENTER, window.W.CFG.MAP_ZOOM);
    const layer = L.layerGroup().addTo(map);
    loadPerimeter().then(geo => {
      if (!geo || !map._container) return;
      const poly = L.geoJSON(geo, {
        style: { color: "#6e1423", weight: 3, dashArray: "8 6", fillColor: "#6e1423", fillOpacity: 0.05 }
      }).addTo(map);
      map.fitBounds(poly.getBounds(), { padding: [12, 12] });
    });
    return { map, layer };
  }

  function dot(latlng, opts) {
    return L.circleMarker(latlng, Object.assign({ radius: 8, weight: 2, color: "#fff", fillOpacity: 1 }, opts));
  }

  function label(m, html, permanent) {
    m.bindTooltip(html, { permanent: !!permanent, direction: "top", offset: [0, -8], className: "map-label" });
    return m;
  }

  // ---------- GPS ----------
  // On « réchauffe » le GPS avant un ping pour avoir une position prête au moment d'appuyer.
  let watchId = null;
  let lastFix = null;

  function startWarmup() {
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      p => { lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }; },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
  }
  function stopWarmup() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  function getFix() {
    if (lastFix && Date.now() - lastFix.at < 15000) return Promise.resolve(lastFix);
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Ce navigateur ne donne pas accès à la position."));
      navigator.geolocation.getCurrentPosition(
        p => {
          lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
          resolve(lastFix);
        },
        err => reject(new Error(err.code === 1
          ? "Accès à la position refusé. Autorise-le dans les réglages du navigateur pour ce site."
          : "Position introuvable. Réessaie à découvert.")),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    });
  }

  // ---------- Son ----------
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* ignoré */ }
  }
  document.addEventListener("click", unlockAudio, { passive: true });
  document.addEventListener("touchstart", unlockAudio, { passive: true });

  function beep(times) {
    if (!audioCtx) return;
    const n = times || 3;
    for (let i = 0; i < n; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "square"; o.frequency.value = 880;
      const t = audioCtx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.3);
    }
  }

  function ago(iso) {
    return iso ? `à ${fmtTime(iso)}` : "";
  }

  window.WG = { loadPerimeter, createMap, dot, label, startWarmup, stopWarmup, getFix, beep, ago, esc };
})();
