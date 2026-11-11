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

  // Icônes SVG au trait (24 × 24), couleur héritée du texte.
  const ICONS = {
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
    send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4 18-7z"/>',
    eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-3.2 3.9M6.1 6.1C3 8 1 12 1 12s4 7 11 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    alert: '<path d="M12 3L2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5"/>',
    stop: '<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8l6-6z"/><path d="M8 12h8"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 21h8M9 17h6"/>',
    msg: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    run: '<circle cx="15" cy="4.5" r="2"/><path d="M8 21l3-6 3 2v4M6 12l3-3 4 1 3 3 3 1M11 15l-1-5"/>'
  };
  function icon(name, cls) {
    return `<svg class="ico ${cls || ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  // Petits lutins originaux (décor des zones vides uniquement, sans animation).
  function elf(variant) {
    const hat = variant === 2 ? "#8E1F2C" : "#1F4D3A";
    const scarf = variant === 2 ? "#1F4D3A" : "#8E1F2C";
    const extra = variant === 2
      ? '<path d="M44 40l7-6" stroke="#2D241E" stroke-width="2.5" stroke-linecap="round"/><rect x="48" y="27" width="8" height="9" rx="1.5" fill="#C9A227" stroke="#2D241E" stroke-width="2"/>'
      : '<path d="M15 41l-7-7" stroke="#2D241E" stroke-width="2.5" stroke-linecap="round"/><circle cx="7" cy="33" r="2.5" fill="#F2C9A0" stroke="#2D241E" stroke-width="1.5"/>';
    return `<svg class="elf" viewBox="0 0 60 72" aria-hidden="true">
      <path d="M17 26 L30 3 L44 24 Z" fill="${hat}" stroke="#2D241E" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="30" cy="4" r="3.5" fill="#F7F5F0" stroke="#2D241E" stroke-width="1.5"/>
      <rect x="15" y="22" width="30" height="6" rx="3" fill="#F7F5F0" stroke="#2D241E" stroke-width="1.5"/>
      <path d="M15 33 L9 29 L15 39 Z M45 33 L51 29 L45 39 Z" fill="#F2C9A0" stroke="#2D241E" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="30" cy="35" r="11" fill="#F2C9A0" stroke="#2D241E" stroke-width="2"/>
      <circle cx="26" cy="34" r="1.5" fill="#2D241E"/><circle cx="34" cy="34" r="1.5" fill="#2D241E"/>
      <path d="M26 39.5 q4 3 8 0" fill="none" stroke="#2D241E" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M19 45 h22 l-2 5 h-18 z" fill="${scarf}" stroke="#2D241E" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M21 50 h18 l3 16 h-24 z" fill="${hat}" stroke="#2D241E" stroke-width="2" stroke-linejoin="round"/>
      <path d="M18 66 h10 M32 66 h10" stroke="#2D241E" stroke-width="3" stroke-linecap="round"/>
      ${extra}
    </svg>`;
  }

  const STATUS_LABELS = {
    accueil: "Accueil",
    dispersion: "Dispersion",
    manche: "Manche en cours",
    regroupement: "Regroupement",
    termine: "Jeu terminé"
  };

  window.W = { CFG, sb, ensureSession, rpc, syncClock, now, msUntil, fmtDuration, fmtTime, esc, toast, buzz, photoUrl, resizeImage, randomName, STATUS_LABELS, icon, elf };
})();
