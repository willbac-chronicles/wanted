// Écran joueur.
(function () {
  const { rpc, ensureSession, syncClock, msUntil, fmtDuration, fmtTime, esc, toast, buzz, photoUrl, STATUS_LABELS, CFG, icon, elf } = window.W;
  const W = window.W, WG = window.WG, WC = window.WC;

  const app = document.getElementById("app");
  const who = document.getElementById("who");

  let state = null;
  let screenKey = "";
  let busy = false;
  let lastMsgId = null;
  let codeHideTimer = null;
  let mapObj = null;
  let liveDot = null;
  let sending = false;
  const notifiedPings = new Set();
  const notifiedSpotted = new Set();
  const KIND_LABELS = { chasseur: "Ping chasseurs", general: "Ping général", manuel: "Ping demandé par l'organisation" };

  const $ = id => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  // ---------- Rendu ----------

  function render() {
    const s = state;
    if (!s || !s.me) { if (screenKey !== "login") renderLogin(); return; }

    who.innerHTML = `${esc(s.me.pseudo)}<br><span class="small muted">${esc(STATUS_LABELS[s.game.status] || "")}${s.game.round ? " · manche " + s.game.round : ""}</span>
      <br><button class="small link" id="logout-btn">${icon("logout")} Déconnexion</button>`;
    $("logout-btn").onclick = logout;
    renderMessages();
    showTabsBar(true);

    const g = s.game;
    const key = [g.status, g.round, s.target ? s.target.pseudo + "|" + s.target.photo_path : "-"].join("#");
    if (key !== screenKey) {
      screenKey = key;
      destroyMap();
      if (g.status === "accueil") renderWaiting();
      else if (g.status === "dispersion") renderDispersion();
      else if (g.status === "manche") renderRound();
      else renderBoard();
    }
    updateLive();
  }

  function renderLogin() {
    screenKey = "login";
    who.textContent = "";
    showTabsBar(false);
    showTab("jeu");
    $("messages").classList.add("hidden");
    app.innerHTML = `
      <div class="decor">${elf(1)}${elf(2)}</div>
      <div class="card center">
        <h1>Avis de recherche</h1>
        <p class="muted">Entre le code personnel remis par l'organisation.</p>
        <label for="access-code">Code d'accès</label>
        <input class="code" id="access-code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" />
        <p></p>
        <button class="primary big" id="login-btn">Entrer</button>
      </div>`;
    const input = $("access-code");
    const go = async () => {
      const code = input.value.trim();
      if (!code) return;
      const btn = $("login-btn");
      btn.disabled = true;
      try {
        await ensureSession();
        const r = await rpc("claim_player", { p_code: code });
        toast(`Bienvenue, ${r.pseudo} !`, "ok");
        screenKey = "";
        await refresh();
      } catch (e) {
        toast(e.message, "red");
        btn.disabled = false;
      }
    };
    $("login-btn").onclick = go;
    input.onkeydown = e => { if (e.key === "Enter") go(); };
  }

  function renderWaiting() {
    app.innerHTML = `
      <div class="decor">${elf(1)}${elf(2)}</div>
      <div class="card">
        <h2>En attente du départ</h2>
        <p>Tu es inscrit. L'organisation lancera bientôt la dispersion.</p>
      </div>
      <div id="push-box"></div>
      <div class="card">
        <h3>Règles clés</h3>
        <ul>
          <li>Chaque joueur est à la fois <b>chasseur</b> et <b>cible</b>.</li>
          <li>Ta cible est en vue ? Appuie sur <b>Wanted !</b> : elle est prévenue et doit s'arrêter. Tu as alors <b>1 minute</b> pour la rejoindre et saisir son code (3 essais).</li>
          <li>Code bon : <b>+3</b> pour toi, <b>−2</b> pour elle. Minute écoulée : elle est <b>immunisée 2 min</b> et ton bouton est <b>bloqué 2 min</b>.</li>
          <li>Si tu es repéré, arrête-toi et montre ton code au chasseur.</li>
          <li>Aux pings, tu as <b>1 minute</b> pour appuyer sur « Envoyer ma position ». Ping manqué : <b>−3</b>.</li>
          <li>Active les notifications ci-dessus, garde le son activé et coupe « Ne pas déranger » pendant la partie.</li>
        </ul>
      </div>
      ${geoPermissionCard()}`;
    bindGeoPermission();
  }

  function geoPermissionCard() {
    return `
      <div class="card info center">
        <h3>${icon("pin")} Localisation</h3>
        <p class="small">Autorise dès maintenant l'accès à ta position, pour ne pas perdre de temps au premier ping.</p>
        <button class="blue" id="geo-allow">${icon("pin")} Autoriser la localisation</button>
        <p class="small muted" id="geo-status"></p>
      </div>`;
  }
  function bindGeoPermission() {
    const b = $("geo-allow");
    if (!b) return;
    b.onclick = async () => {
      const s = $("geo-status");
      s.textContent = "Recherche de ta position…";
      try {
        const f = await WG.getFix();
        s.textContent = `Localisation OK (précision ${Math.round(f.accuracy)} m).`;
      } catch (e) { s.textContent = e.message; }
    };
  }

  function renderDispersion() {
    app.innerHTML = `
      <div class="card center">
        <h2>${icon("run", "lg")} Dispersion</h2>
        <p class="muted">Éloigne-toi. Ta cible sera révélée au START.</p>
        <div class="countdown" data-until="${esc(state.game.start_at)}" data-refresh-at-zero="1">--:--</div>
        <p class="small muted">START à ${esc(fmtTime(state.game.start_at))}</p>
      </div>
      <div id="push-box"></div>
      ${mapCard("Reste dans le périmètre pointillé.")}
      ${geoPermissionCard()}`;
    bindGeoPermission();
    buildMap();
  }

  function mapCard(hint) {
    return `
      <div class="card info">
        <div class="row">
          <h3 class="grow">${icon("pin")} Carte</h3>
          <button class="small" id="center-me">${icon("pin")} Centrer sur moi</button>
        </div>
        <div id="map" class="map"></div>
        <p class="small muted" id="live-info">Recherche de ta position en direct…</p>
        <p class="small muted" id="map-info">${esc(hint || "")}</p>
      </div>`;
  }

  // Carte + point « moi en direct » (jamais envoyé au serveur).
  function buildMap() {
    destroyMap();
    mapObj = WG.createMap($("map"));
    liveDot = WG.attachLiveDot(mapObj, $("live-info"));
    $("center-me").onclick = () => {
      if (!liveDot || !liveDot.center()) toast("Position en direct pas encore trouvée.", "blue");
    };
    updateMap();
  }

  function destroyMap() {
    if (liveDot) { liveDot.stop(); liveDot = null; }
    if (mapObj) { mapObj.map.remove(); mapObj = null; }
  }

  function renderRound() {
    const t = state.target;
    app.innerHTML = `
      <div class="card">
        <div class="row">
          <div class="grow"><span class="muted small">${icon("clock")} Fin de manche dans</span><br>
            <span class="timer" data-until="${esc(state.game.end_at)}" data-refresh-at-zero="1">--:--</span></div>
          <div id="immunity"></div>
        </div>
        <div id="hunters-count" class="hunters"></div>
      </div>
      <div id="spotted-box"></div>
      <div id="push-box"></div>
      ${t ? `
      <div class="poster">
        <div class="wanted">WANTED</div>
        <div class="sub">MANCHE ${esc(state.game.round)}</div>
        <div class="photo" id="target-photo">${t.photo_path ? "" : "Pas de photo"}</div>
        <div class="name">${esc(t.pseudo)}</div>
        <div class="state" id="target-state"></div>
      </div>
      <div class="card" id="action-box"></div>` : `
      <div class="card center"><p>Aucune cible pour le moment. Patiente un instant…</p></div>`}
      <div class="card" id="ping-box"></div>
      ${mapCard()}
      <div class="card">
        <div class="scores">
          <div><div class="v" id="sc-round">0</div><div class="k">${icon("star")} Manche</div></div>
          <div><div class="v" id="sc-total">0</div><div class="k">${icon("trophy")} Total</div></div>
          <div><div class="v" id="sc-caps">0</div><div class="k">${icon("target")} Captures</div></div>
        </div>
      </div>
      <div class="card center">
        <button class="big" id="show-code">${icon("eye")} Afficher mon code</button>
        <div class="mycode hidden" id="mycode"></div>
        <p class="small muted hidden" id="mycode-hint">Montre-le seulement au chasseur qui t'a repéré. Masqué dans 15 s.</p>
      </div>`;

    if (t && t.photo_path) {
      photoUrl(t.photo_path).then(url => {
        const el = $("target-photo");
        if (el && url) el.style.backgroundImage = `url("${url}")`;
      });
    }
    $("show-code").onclick = toggleCode;

    buildMap();
  }

  // ---------- Carte ----------

  function updateMap() {
    if (!mapObj || !state) return;
    const { layer } = mapObj;
    layer.clearLayers();
    const info = [];
    (state.public_positions || []).forEach(p => {
      if (state.me && p.pseudo === state.me.pseudo) return;
      WG.label(WG.dot([p.lat, p.lng], { fillColor: "#5C5248", radius: 7 }).addTo(layer),
        `${esc(p.pseudo)} ${WG.ago(p.sent_at)}`);
    });
    const t = state.target;
    if (t && t.position) {
      WG.label(WG.dot([t.position.lat, t.position.lng], { fillColor: "#8E1F2C", radius: 10 }).addTo(layer),
        `Cible : ${esc(t.pseudo)} ${WG.ago(t.position.sent_at)}`, true);
      info.push(`Dernière position de ta cible : ${fmtTime(t.position.sent_at)}.`);
    } else if (t) {
      info.push("Position de ta cible inconnue pour l'instant : elle apparaîtra au prochain ping.");
    }
    const me = state.my_position;
    if (me) {
      WG.label(WG.dot([me.lat, me.lng], { fillColor: "#5C5248", radius: 6 }).addTo(layer),
        `Ton dernier ping ${WG.ago(me.sent_at)}${me.out ? " · hors zone" : ""}`);
      if (me.out) info.push("Attention : ta dernière position était hors du périmètre.");
    }
    if ((state.public_positions || []).length) info.push("Ping général : positions des autres joueurs visibles.");
    if (state.game.status === "manche") setText("map-info", info.join(" "));
  }

  // ---------- Repérage « Wanted ! » ----------

  // Zone d'action sous l'avis de recherche : bouton « Wanted ! » ou saisie du code pendant la minute.
  function updateActionBox() {
    const box = $("action-box");
    if (!box || !state.target) return;
    const spot = state.spot;
    const lockLeft = msUntil(state.me.locked_until);
    const immLeft = msUntil(state.target.immune_until);

    let key;
    if (spot && msUntil(spot.expires_at) > -5000) key = "spot" + spot.expires_at;
    else if (lockLeft > 0) key = "lock";
    else if (immLeft > 0) key = "imm";
    else key = "idle";

    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.className = key.startsWith("spot") ? "card alert" : "card";
      if (key.startsWith("spot")) {
        box.innerHTML = `
          <h2>${icon("run", "lg")} Rejoins ta cible !</h2>
          <p class="center"><span class="timer red" id="spot-left"></span> <span class="muted">pour saisir son code</span></p>
          <label for="capture-input">Code à 4 chiffres de ta cible</label>
          <input class="code" id="capture-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" />
          <p class="small" id="capture-feedback"></p>
          <button class="green big" id="capture-submit">${icon("check")} Valider la capture</button>`;
        $("capture-submit").onclick = submitCapture;
        $("capture-input").onkeydown = e => { if (e.key === "Enter") submitCapture(); };
        setTimeout(() => { const i = $("capture-input"); if (i) i.focus(); }, 50);
      } else {
        box.innerHTML = `
          <button class="primary huge" id="wanted-btn">${icon("target", "lg")} Wanted !</button>
          <p class="small center muted" id="wanted-info"></p>`;
        $("wanted-btn").onclick = spotTarget;
      }
    }

    if (key.startsWith("spot")) {
      setText("spot-left", fmtDuration(msUntil(spot.expires_at)));
      return;
    }
    const btn = $("wanted-btn");
    if (key === "lock") {
      btn.disabled = true;
      setText("wanted-info", `Bouton bloqué encore ${fmtDuration(lockLeft)} (repérage raté).`);
    } else if (key === "imm") {
      btn.disabled = true;
      setText("wanted-info", `Ta cible est immunisée encore ${fmtDuration(immLeft)}.`);
    } else {
      btn.disabled = false;
      setText("wanted-info", "Ta cible est en vue ? Elle sera prévenue et devra s'arrêter. Tu auras 1 minute pour saisir son code.");
    }
  }

  function updateTargetState() {
    const el = $("target-state");
    if (!el || !state.target) return;
    const left = msUntil(state.target.immune_until);
    el.innerHTML = left > 0 ? `<span class="badge green">${icon("shield")} Immunisée ${fmtDuration(left)}</span>` : "";
  }

  async function spotTarget() {
    if (busy) return;
    if (!confirm("Ta cible est bien en vue ? Elle va être prévenue et tu auras 1 minute pour saisir son code.")) return;
    busy = true;
    try {
      const r = await rpc("spot_target");
      if (r.ok) {
        buzz([150]);
        toast("Ta cible est prévenue : tu as 1 minute !", "red");
      } else {
        const msgs = {
          cooldown: "Bouton Wanted ! bloqué pour l'instant.",
          immune: "Ta cible est immunisée pour l'instant.",
          already_spotted: "Un autre chasseur vient déjà de repérer cette cible. Réessaie dans une minute.",
          target_changed: "Ta cible a changé. Regarde ta nouvelle fiche.",
          no_target: "Tu n'as pas de cible pour le moment.",
          not_running: "La manche n'est pas en cours."
        };
        toast(msgs[r.reason] || "Refusé.", "red");
      }
      await refresh();
    } catch (e) { toast(e.message, "red"); }
    finally { busy = false; }
  }

  async function submitCapture() {
    const input = $("capture-input"), fb = $("capture-feedback"), btn = $("capture-submit");
    if (!input) return;
    const code = input.value.replace(/\D/g, "");
    if (code.length !== 4) { fb.textContent = "Le code fait 4 chiffres."; return; }
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      const r = await rpc("submit_capture", { p_code: code });
      if (r.ok) {
        buzz([100, 60, 100, 60, 300]);
        toast(`${r.captured} est tombé ! +3. Nouvelle cible : ${r.new_target || "…"}`, "ok");
        screenKey = "";
        await refresh();
      } else if (r.reason === "wrong_code") {
        buzz([300]);
        fb.innerHTML = `${icon("alert")} Code faux. Encore ${esc(r.attempts_left)} essai(s).`;
        input.value = "";
        input.focus();
      } else {
        const msgs = {
          failed: "3 codes faux : repérage raté. Ta cible est immunisée 2 min et ton bouton est bloqué 2 min.",
          expired: "Minute écoulée : repérage raté. Ta cible est immunisée 2 min et ton bouton est bloqué 2 min.",
          no_spot: "Appuie d'abord sur Wanted !",
          target_changed: "Ta cible a changé. Regarde ta nouvelle fiche.",
          no_target: "Tu n'as pas de cible pour le moment.",
          not_running: "La manche n'est pas en cours."
        };
        toast(msgs[r.reason] || "Refusé.", "red");
        await refresh();
      }
    } catch (e) {
      fb.textContent = e.message;
    } finally {
      busy = false;
      if ($("capture-submit")) $("capture-submit").disabled = false;
    }
  }

  // Bandeau quand je suis repéré.
  function updateSpottedBox() {
    const box = $("spotted-box");
    if (!box) return;
    const sp = state.spotted;
    const active = sp && msUntil(sp.expires_at) > -5000;
    if (!active) {
      if (box.dataset.key) { box.dataset.key = ""; box.className = ""; box.innerHTML = ""; }
      return;
    }
    if (!notifiedSpotted.has(sp.id)) {
      notifiedSpotted.add(sp.id);
      buzz([700, 200, 700, 200, 700]);
      WG.beep(4);
      toast("Tu es repéré ! Arrête-toi.", "red");
    }
    if (box.dataset.key !== String(sp.id)) {
      box.dataset.key = String(sp.id);
      box.className = "card alert spotted";
      box.innerHTML = `
        <h2>${icon("stop", "lg")} Tu es repéré !</h2>
        <p><b>Arrête-toi.</b> Un chasseur a <span class="timer red" id="spotted-left"></span> pour te rejoindre.</p>
        <p class="small muted">Montre-lui ton code :</p>
        <div class="mycode">${esc(state.me.capture_code)}</div>`;
    }
    setText("spotted-left", fmtDuration(msUntil(sp.expires_at)));
  }

  // ---------- Pings ----------

  // Fenêtre de ping ouverte (non envoyée) et prochain ping.
  function pingStatus() {
    const list = (state && state.pings) || [];
    const t = W.now();
    const inWin = p => t >= new Date(p.scheduled_at).getTime() && t <= new Date(p.window_end).getTime();
    return {
      open: list.find(p => inWin(p) && !p.sent),
      sentNow: list.find(p => inWin(p) && p.sent),
      next: list.find(p => new Date(p.scheduled_at).getTime() > t)
    };
  }

  function updatePingBox() {
    const box = $("ping-box");
    if (!box) return;
    const { open, sentNow, next } = pingStatus();

    // Réchauffe le GPS 45 s avant un ping, et pendant la fenêtre.
    const soon = next && msUntil(next.scheduled_at) < 45000;
    if (open || soon) WG.startWarmup(); else WG.stopWarmup();

    if (open) {
      if (!notifiedPings.has(open.id)) {
        notifiedPings.add(open.id);
        buzz([400, 150, 400, 150, 400]);
        WG.beep(3);
        toast(`${KIND_LABELS[open.kind]} : envoie ta position !`, "blue");
      }
      const key = "open" + open.id;
      if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.className = "card ping-open";
        box.innerHTML = `
          <h2>${icon("pin", "lg")} ${esc(KIND_LABELS[open.kind])}</h2>
          <button class="blue big" id="send-pos">${icon("send")} Envoyer ma position</button>
          <p class="center"><span class="timer blue" id="ping-left"></span> <span class="small muted">pour l'envoyer</span></p>`;
        $("send-pos").onclick = () => sendPosition();
      }
      setText("ping-left", fmtDuration(msUntil(open.window_end)));
      return;
    }

    let key, html;
    if (sentNow) {
      key = "sent" + sentNow.id;
      html = `<p class="center"><span class="badge green">${icon("check")} Position envoyée</span></p>`;
    } else if (next) {
      key = "next" + next.id;
      html = `<div class="row"><div class="grow"><span class="muted small">${icon("pin")} ${esc(KIND_LABELS[next.kind])} dans</span><br>
              <span class="timer blue" id="ping-next"></span></div><span class="small muted">à ${esc(fmtTime(next.scheduled_at))}</span></div>`;
    } else {
      key = "none";
      html = `<p class="small muted center">Plus de ping prévu dans cette manche.</p>`;
    }
    if (box.dataset.key !== key) { box.dataset.key = key; box.className = "card info"; box.innerHTML = html; }
    if (next) setText("ping-next", fmtDuration(msUntil(next.scheduled_at)));
  }

  async function sendPosition() {
    if (sending) return;
    sending = true;
    const btn = $("send-pos");
    if (btn) { btn.disabled = true; btn.textContent = "Localisation…"; }
    try {
      const f = await WG.getFix();
      const r = await rpc("send_position", { p_lat: f.lat, p_lng: f.lng, p_accuracy: f.accuracy });
      if (r.ok) {
        toast(r.out_of_perimeter ? `Position envoyée, mais tu es hors du périmètre (≈ ${r.distance_m} m) !` : "Position envoyée.",
              r.out_of_perimeter ? "red" : "ok");
      } else {
        toast(r.reason === "no_window" ? "Trop tard : la fenêtre de ping est fermée." : "Envoi refusé.", "red");
      }
      await refresh();
    } catch (e) {
      toast(e.message, "red");
      if (btn) { btn.disabled = false; btn.innerHTML = `${icon("send")} Réessayer`; }
    } finally {
      sending = false;
    }
  }

  // ---------- Classement, messages ----------

  function renderBoard() {
    const final = state.game.status === "termine";
    app.innerHTML = `
      <div class="decor">${elf(1)}${elf(2)}</div>
      <div class="card center">
        <h2>${icon("trophy", "lg")} ${final ? "Classement final" : "Regroupement"}</h2>
        <p class="muted">${final ? "Merci d'avoir joué !" : `Fin de la manche ${esc(state.game.round)}. Rejoins le point de rendez-vous.`}</p>
        <p><span class="badge gold">${icon("star")} ${esc(state.me.score_total)} points</span></p>
      </div>
      <div class="card"><ol class="board" id="board"><li class="muted">Chargement…</li></ol></div>`;
    loadBoard();
  }

  async function loadBoard() {
    try {
      const rows = await rpc("get_leaderboard");
      const el = $("board");
      if (!el) return;
      el.innerHTML = rows.map(r => `<li>${esc(r.pseudo)} <span class="pts">${esc(r.total)} pts</span></li>`).join("") || "<li>—</li>";
    } catch (e) { /* on réessaiera au prochain rafraîchissement */ }
  }

  function renderMessages() {
    const box = $("messages");
    const list = state.messages || [];
    box.classList.toggle("hidden", list.length === 0);
    $("msg-list").innerHTML = list.map(m =>
      `<li><div class="t">${esc(fmtTime(m.created_at))}${m.private ? " · pour toi" : ""}</div>${esc(m.body)}</li>`).join("");
  }

  // ---------- Mises à jour chaque seconde ----------

  function updateLive() {
    const s = state;
    if (!s || !s.me) return;
    setText("sc-round", s.me.score_round);
    setText("sc-total", s.me.score_total);
    setText("sc-caps", s.me.captures_round);

    const imm = $("immunity");
    if (imm) {
      const left = msUntil(s.me.immune_until);
      imm.innerHTML = left > 0 ? `<span class="badge green">${icon("shield")} Immunisé ${fmtDuration(left)}</span>` : "";
    }

    const mc = $("mycode");
    if (mc) mc.textContent = s.me.capture_code;

    const hc = $("hunters-count");
    if (hc) {
      const n = s.me.hunters || 0;
      const html = n === 0
        ? `<span class="badge plain">${icon("shield")} Aucun chasseur à tes trousses</span>`
        : `<span class="badge ${n >= 2 ? "red" : "plain"}">${icon("run")} ${n} chasseur${n > 1 ? "s" : ""} à tes trousses</span>`
          + (n >= 2 ? ` <span class="small muted">Tiens jusqu'au prochain ping chasseurs : +1 bonus survivant.</span>` : "");
      if (hc.dataset.n !== String(n)) { hc.dataset.n = String(n); hc.innerHTML = html; }
    }

    updateSpottedBox();
    updateActionBox();
    updateTargetState();
    updatePingBox();

    let needRefresh = false;
    document.querySelectorAll("[data-until]").forEach(el => {
      const left = msUntil(el.dataset.until);
      el.textContent = fmtDuration(left);
      if (left <= 0 && el.dataset.refreshAtZero === "1") { el.dataset.refreshAtZero = "0"; needRefresh = true; }
    });
    if (state.spot && msUntil(state.spot.expires_at) < -6000) needRefresh = true;
    if (needRefresh && !updateLive.pending) {
      updateLive.pending = true;
      setTimeout(() => { updateLive.pending = false; refresh(); }, 800);
    }
  }

  function toggleCode() {
    const mc = $("mycode"), hint = $("mycode-hint"), btn = $("show-code");
    const show = mc.classList.contains("hidden");
    mc.classList.toggle("hidden", !show);
    hint.classList.toggle("hidden", !show);
    btn.innerHTML = show ? `${icon("eyeOff")} Masquer mon code` : `${icon("eye")} Afficher mon code`;
    clearTimeout(codeHideTimer);
    if (show) codeHideTimer = setTimeout(() => { if (!mc.classList.contains("hidden")) toggleCode(); }, 15000);
  }

  // ---------- Onglets Jeu / Quêtes / Chat ----------

  let tab = "jeu";
  $("tab-ico-jeu").innerHTML = icon("target");
  $("tab-ico-quetes").innerHTML = icon("flag");
  $("tab-ico-chat").innerHTML = icon("msg");

  function showTabsBar(on) {
    $("player-tabs").classList.toggle("hidden", !on);
    document.body.classList.toggle("has-player-tabs", on);
  }
  function showTab(name) {
    tab = name;
    document.querySelectorAll("#player-tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    ["jeu", "quetes", "chat"].forEach(t => $("panel-" + t).classList.toggle("hidden", t !== name));
    window.scrollTo(0, 0);
    if (name === "jeu" && mapObj) setTimeout(() => mapObj.map.invalidateSize(), 50);
    updateTabs(true);
  }
  $("player-tabs").onclick = e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); };

  function setBadge(id, text) {
    const el = $(id);
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
  }

  // Appelée à chaque rafraîchissement : badges, et contenu de l'onglet ouvert.
  let questsLoadedAt = 0;
  function updateTabs(force) {
    if (!state || !state.me) return;
    const q = state.quests || {}, c = state.chat || {};
    setBadge("badge-quetes", q.todo > 0 ? String(q.todo) : "");
    if (tab === "chat") {
      chat.load(false).then(() => WC.setSeen("wanted-chat-seen", chat.st.lastId));
      setBadge("badge-chat", "");
    } else {
      setBadge("badge-chat", (c.last_id || 0) > WC.getSeen("wanted-chat-seen") ? "•" : "");
    }
    const off = c.enabled === false;
    $("chat-body").disabled = off; $("chat-send").disabled = off;
    $("chat-hint").textContent = off
      ? "Le chat est fermé par l'organisation pour le moment."
      : "Visible de tous les joueurs et de l'organisation. Ne donne pas ta position ni ton code !";
    if (tab === "quetes" && (force || Date.now() - questsLoadedAt > 10000)) loadQuests();
  }

  // ---------- Quêtes ----------

  const QUEST_STATE = {
    en_attente: `<span class="badge blue">${icon("clock")} En attente de validation</span>`,
    validee: `<span class="badge green">${icon("check")} Validée</span>`,
    refusee: `<span class="badge plain">${icon("alert")} Refusée : tu peux la redéclarer</span>`
  };
  async function loadQuests() {
    questsLoadedAt = Date.now();
    try {
      const list = await rpc("get_quests");
      $("quest-list").innerHTML = list.map(q => `
        <div class="card quest-card${q.done ? " done" : ""}">
          <div class="row">
            <h3 class="grow" style="margin:0">${icon("flag")} ${esc(q.title)}</h3>
            <span class="badge gold">${icon("star")} ${esc((q.points > 0 ? "+" : "") + q.points)} pt</span>
          </div>
          ${q.description ? `<p style="margin-top:8px">${esc(q.description)}</p>` : ""}
          <p class="small muted">${q.personal ? "Quête personnelle" : "Pour tout le monde"}${q.round ? " · manche " + q.round : ""}</p>
          ${q.status ? `<p>${QUEST_STATE[q.status]}</p>` : ""}
          ${!q.status || q.status === "refusee" ? `<button class="green" data-quest="${q.id}">${icon("check")} J'ai réussi</button>` : ""}
        </div>`).join("") || `<div class="card center"><div class="decor">${elf(2)}</div><p class="muted">Aucune quête pour l'instant. Reviens plus tard !</p></div>`;
    } catch (e) { $("quest-list").innerHTML = `<p class="muted center">${esc(e.message)}</p>`; }
  }
  $("quest-list").onclick = async e => {
    const b = e.target.closest("button[data-quest]");
    if (!b) return;
    const note = prompt("Un mot pour l'organisation (facultatif) : comment as-tu réussi ?", "");
    if (note === null) return;
    b.disabled = true;
    try {
      await rpc("claim_quest", { p_quest: Number(b.dataset.quest), p_note: note });
      toast("Quête déclarée : l'organisation va la valider.", "ok");
      await loadQuests();
    } catch (err) { toast(err.message, "red"); b.disabled = false; }
  };

  // ---------- Chat ----------

  const chat = WC.mount($("chat-list"), $("chat-body"), $("chat-send"), {});

  // ---------- Déconnexion ----------

  async function logout() {
    if (!confirm("Te déconnecter de ce téléphone ? Tu ne recevras plus les alertes ici. Il faudra ton code d'accès pour revenir.")) return;
    if (window.WP) await window.WP.disable();
    W.logout();
  }

  // ---------- Synchronisation ----------

  function detectEvents(prev, next) {
    if (!prev || !prev.me || !next.me) return;
    if (prev.game.status === "manche" && next.game.status === "manche") {
      if (prev.me.capture_code !== next.me.capture_code) {
        buzz([500, 150, 500]);
        toast("On t'a trouvé ! −2. Nouveau code et 2 min d'immunité.", "red");
      }
      if (prev.spotted && !next.spotted && prev.me.capture_code === next.me.capture_code) {
        toast("Le chasseur n'a pas réussi : tu es immunisé 2 min. Tu peux repartir !", "ok");
      }
      if (prev.spot && !next.spot && next.me.locked_until && !prev.me.locked_until) {
        toast("Repérage raté : ta cible est immunisée 2 min et ton bouton est bloqué 2 min.", "red");
      }
      const h0 = prev.me.hunters || 0, h1 = next.me.hunters || 0;
      if (h1 > h0) {
        buzz([300, 120, 300]);
        toast(h1 - h0 === 1 ? `Un chasseur de plus à tes trousses : ${h1} au total.` : `${h1 - h0} chasseurs de plus à tes trousses : ${h1} au total.`, "red");
      }
      const a = prev.target && prev.target.pseudo, b = next.target && next.target.pseudo;
      if (a && b && a !== b) {
        buzz();
        toast(`Nouvelle cible : ${b}`);
      }
    }
    if (prev.game.status !== next.game.status) {
      buzz();
      if (next.game.status === "manche") toast("START ! Ta cible est révélée.", "red");
      if (next.game.status === "regroupement") toast("Fin de la manche !");
    }
    const newest = next.messages && next.messages[0];
    if (newest && lastMsgId !== null && newest.id !== lastMsgId) {
      buzz();
      toast(`Message : ${newest.body}`, "blue");
    }
  }

  async function refresh() {
    try {
      await ensureSession();
      const next = await rpc("get_my_state");
      syncClock(next.server_now);
      detectEvents(state, next);
      const newest = next.messages && next.messages[0];
      lastMsgId = newest ? newest.id : (lastMsgId === null ? 0 : lastMsgId);
      state = next;
      render();
      updateMap();
      if (window.WP && next.me) window.WP.fill($("push-box"), next.me.push_devices, next.game.status === "manche");
      updateTabs(false);
      if (next.game.status !== "manche") WG.stopWarmup();
      if (["regroupement", "termine"].includes(next.game.status) && next.me) loadBoard();
    } catch (e) {
      if (!state) app.innerHTML = `<div class="card center"><p>Connexion impossible.</p><p class="small muted">${esc(e.message)}</p><button id="retry">Réessayer</button></div>`;
      const r = $("retry");
      if (r) r.onclick = refresh;
    }
  }

  // Rafraîchissement : toutes les 3 s pendant une manche (repérages, pings manuels), 10 s sinon.
  (function loop() {
    const ms = state && state.game && state.game.status === "manche" ? 3000 : (CFG.POLL_INTERVAL_MS || 10000);
    setTimeout(() => { refresh().finally(loop); }, ms);
  })();
  setInterval(updateLive, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  refresh();
})();
