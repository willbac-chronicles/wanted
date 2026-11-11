// Outils partagés : client Supabase, session anonyme, horloge serveur, affichage.
(function () {
  const CFG = window.WANTED_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "wanted-auth" }
  });

  async function ensureSession() {
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session;
    const res = await sb.auth.signInAnonymously();
    if (res.error) throw res.error;
    return res.data.session;
  }

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw new Error(error.message || "Erreur serveur");
    return data;
  }

  // Horloge : on se cale sur l'heure du serveur, pas sur celle du téléphone.
  let offset = 0;
  function syncClock(serverNow) {
    if (serverNow) offset = new Date(serverNow).getTime() - Date.now();
  }
  function now() { return Date.now() + offset; }
  function msUntil(iso) { return iso ? new Date(iso).getTime() - now() : 0; }

  function fmtDuration(ms) {
    ms = Math.max(0, ms);
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function fmtTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: CFG.TIMEZONE });
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let toastTimer;
  function toast(msg, kind) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.className = kind || "";
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern || [200, 100, 200]); } catch (e) { /* ignoré */ }
  }

  // Liens signés des photos, mis en cache 50 min.
  const photoCache = new Map();
  async function photoUrl(path) {
    if (!path) return null;
    const hit = photoCache.get(path);
    if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await sb.storage.from("photos").createSignedUrl(path, 3600);
    if (error) return null;
    photoCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  // Réduit une photo prise au téléphone avant l'envoi (≈ 900 px, JPEG).
  function resizeImage(file, max) {
    max = max || 900;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k);
        c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob(b => (b ? resolve(b) : reject(new Error("Image illisible"))), "image/jpeg", 0.85);
      };
      img.onerror = () => reject(new Error("Image illisible"));
      img.src = URL.createObjectURL(file);
    });
  }

  function randomName(ext) {
    const id = (crypto.randomUUID && crypto.randomUUID()) ||
      Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    return `${id}.${ext || "jpg"}`;
  }

  const STATUS_LABELS = {
    accueil: "Accueil",
    dispersion: "Dispersion",
    manche: "Manche en cours",
    regroupement: "Regroupement",
    termine: "Jeu terminé"
  };

  window.W = { CFG, sb, ensureSession, rpc, syncClock, now, msUntil, fmtDuration, fmtTime, esc, toast, buzz, photoUrl, resizeImage, randomName, STATUS_LABELS };
})();
