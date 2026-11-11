// Notifications web (Web Push) côté joueur : activation, guide iPhone, encart d'état.
(function () {
  const W = window.W;
  const { rpc, icon, esc } = W;

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
    || navigator.standalone === true;
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  let regPromise = null;
  function registration() {
    if (!regPromise) {
      regPromise = navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready);
      regPromise.catch(() => { regPromise = null; });
    }
    return regPromise;
  }
  if ("serviceWorker" in navigator) registration().catch(() => {});

  function b64ToBytes(v) {
    const pad = "=".repeat((4 - v.length % 4) % 4);
    const raw = atob((v + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function publicKey() {
    const { data, error } = await W.sb.functions.invoke("push-dispatch", { body: { mode: "public-key" } });
    if (error) throw new Error("Service de notifications indisponible.");
    if (!data || !data.publicKey) throw new Error("Clé de notifications indisponible.");
    return data.publicKey;
  }

  async function save(sub) {
    const j = sub.toJSON();
    return rpc("save_push_subscription", {
      p_endpoint: j.endpoint, p_p256dh: j.keys && j.keys.p256dh, p_auth: j.keys && j.keys.auth,
      p_user_agent: navigator.userAgent
    });
  }

  async function currentSub() {
    if (!supported()) return null;
    const reg = await registration();
    return reg.pushManager.getSubscription();
  }

  // À appeler depuis un appui (exigé par les navigateurs pour demander l'autorisation).
  async function enable() {
    if (isIOS() && !isStandalone()) throw new Error("Sur iPhone, installe d'abord Wanted sur l'écran d'accueil (voir ci-dessous).");
    if (!supported()) throw new Error("Ce navigateur ne gère pas les notifications web.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications refusées. Autorise-les dans les réglages du téléphone pour ce site.");
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(await publicKey()) });
    }
    await save(sub);
    resynced = true;
    return sub;
  }

  // Si le téléphone est déjà abonné mais que le serveur l'a oublié (purge, nouveau lien), on réenregistre.
  let resynced = false;
  async function resync(serverDevices) {
    if (resynced || !supported() || Notification.permission !== "granted") return;
    resynced = true;
    try {
      const sub = await currentSub();
      if (sub && !serverDevices) await save(sub);
    } catch (e) { /* sans gravité : le bouton reste disponible */ }
  }

  async function status(serverDevices) {
    if (isIOS() && !isStandalone()) return "ios-install";
    if (!supported()) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    if (Notification.permission === "granted") {
      const sub = await currentSub().catch(() => null);
      if (sub && serverDevices) return "active";
    }
    return "inactive";
  }

  const IOS_GUIDE = `
    <ol class="small steps">
      <li>Dans Safari, touche le bouton <b>Partager</b> (carré avec une flèche vers le haut).</li>
      <li>Choisis <b>« Sur l'écran d'accueil »</b>, puis <b>Ajouter</b>.</li>
      <li>Ouvre <b>Wanted</b> depuis la nouvelle icône et entre à nouveau ton code d'accès.</li>
      <li>Touche alors <b>« Activer les notifications »</b> et accepte.</li>
    </ol>
    <p class="small muted">iOS 16.4 ou plus récent requis.</p>`;

  // Remplit l'encart `box`. compact : n'affiche rien quand tout est actif (écran de manche).
  async function fill(box, serverDevices, compact) {
    if (!box) return;
    resync(serverDevices);
    const st = await status(serverDevices);
    if (box.dataset.st === st) return;
    box.dataset.st = st;
    if (compact && st === "active") { box.className = "hidden"; box.innerHTML = ""; return; }

    let html = "";
    if (st === "active") {
      html = `<h3>${icon("check")} Notifications activées</h3>
        <p class="small">Tu seras prévenu même téléphone verrouillé : « Wanted ! », pings, START et messages.</p>
        <p class="small muted">Laisse le son et la vibration activés, et coupe le mode « Ne pas déranger » pendant le jeu.</p>`;
    } else if (st === "ios-install") {
      html = `<h3>${icon("alert")} Notifications : installe l'appli</h3>
        <p class="small">Sur iPhone, les alertes téléphone verrouillé n'arrivent que si Wanted est sur l'écran d'accueil.</p>
        ${IOS_GUIDE}`;
    } else if (st === "unsupported") {
      html = `<h3>${icon("alert")} Notifications indisponibles</h3>
        <p class="small">Ce navigateur ne gère pas les notifications web. Garde la page ouverte pendant la partie, ou essaie avec Chrome (Android) ou Safari (iPhone, depuis l'écran d'accueil).</p>`;
    } else if (st === "denied") {
      html = `<h3>${icon("alert")} Notifications bloquées</h3>
        <p class="small">Tu les as refusées. Réautorise-les dans les réglages du téléphone (Réglages › Notifications › Wanted sur iPhone ; icône du cadenas › Notifications sur Android), puis recharge la page.</p>`;
    } else {
      html = `<h3>${icon("alert")} Active les notifications</h3>
        <p class="small">Indispensable : tu seras alerté quand un chasseur te repère et à chaque ping, même téléphone verrouillé.</p>
        <button class="primary big" id="push-enable">${icon("alert")} Activer les notifications</button>
        <p class="small muted" id="push-msg"></p>`;
    }
    box.className = st === "active" ? "card ok" : "card alert";
    box.innerHTML = html;

    const b = box.querySelector("#push-enable");
    if (b) b.onclick = async () => {
      b.disabled = true;
      const m = box.querySelector("#push-msg");
      m.textContent = "Activation…";
      try {
        await enable();
        box.dataset.st = "";
        fill(box, 1, compact);
        W.toast("Notifications activées", "ok");
      } catch (e) {
        m.textContent = e.message;
        b.disabled = false;
      }
    };
  }

  window.WP = { fill, enable, status, isIOS, isStandalone, supported, esc };
})();
