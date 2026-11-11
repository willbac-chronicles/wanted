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
    // Fond OpenStreetMap standard : sans clé d'API (CARTO en exige une désormais).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    map.setView(window.W.CFG.MAP_CENTER, window.W.CFG.MAP_ZOOM);
    const layer = L.layerGroup().addTo(map);
    loadPerimeter().then(geo => {
      if (!geo || !map._container) return;
      const poly = L.geoJSON(geo, {
        style: { color: "#1E3A5F", weight: 3, dashArray: "8 6", fillColor: "#1E3A5F", fillOpacity: 0.06 }
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
  // Le même suivi GPS sert au réchauffage avant un ping et au point « en direct » sur la carte.
  // La position en direct reste sur le téléphone : seul « Envoyer ma position » l'envoie au serveur.
  let watchId = null;
  let lastFix = null;
  let warm = false;
  const liveListeners = new Set();

  function syncWatch() {
    const want = warm || liveListeners.size > 0;
    if (want && watchId === null && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        p => {
          lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
          liveListeners.forEach(fn => { try { fn(lastFix, null); } catch (e) { /* ignoré */ } });
        },
        err => liveListeners.forEach(fn => { try { fn(null, err); } catch (e) { /* ignoré */ } }),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
      );
    } else if (!want && watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }
  function startWarmup() { warm = true; syncWatch(); }
  function stopWarmup() { warm = false; syncWatch(); }

  // Abonne `fn(fix, err)` au suivi en direct ; renvoie la fonction pour s'en désabonner.
  function watchLive(fn) {
    liveListeners.add(fn);
    syncWatch();
    if (lastFix && Date.now() - lastFix.at < 60000) fn(lastFix, null);
    return () => { liveListeners.delete(fn); syncWatch(); };
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

  // Point « moi en direct » : disque bleu cerclé de blanc + cercle de précision, sur sa propre couche.
  function attachLiveDot(mapObj, infoEl) {
    const layer = L.layerGroup().addTo(mapObj.map);
    let dotM = null, circle = null;
    const stop = watchLive((f, err) => {
      if (!mapObj.map._container) return;
      if (err) {
        if (infoEl) infoEl.textContent = err.code === 1
          ? "Position en direct indisponible : autorise la localisation pour ce site."
          : "Recherche de ta position en direct…";
        return;
      }
      const ll = [f.lat, f.lng];
      if (!dotM) {
        circle = L.circle(ll, { radius: f.accuracy, color: "#1E3A5F", weight: 1, fillColor: "#1E3A5F", fillOpacity: 0.12, interactive: false }).addTo(layer);
        dotM = label(L.circleMarker(ll, { radius: 9, weight: 3, color: "#fff", fillColor: "#1E3A5F", fillOpacity: 1 }).addTo(layer), "Moi (en direct)", true);
      } else {
        dotM.setLatLng(ll);
        circle.setLatLng(ll).setRadius(f.accuracy);
      }
      dotM.bringToFront();
      if (infoEl) infoEl.textContent = `Toi en direct (précision ${Math.round(f.accuracy)} m) : visible seulement par toi.`;
    });
    return {
      stop() { stop(); layer.remove(); },
      center() { if (dotM) mapObj.map.setView(dotM.getLatLng(), Math.max(mapObj.map.getZoom(), 16)); return !!dotM; }
    };
  }

  window.WG = { loadPerimeter, createMap, dot, label, startWarmup, stopWarmup, watchLive, attachLiveDot, getFix, beep, ago, esc };
})();
