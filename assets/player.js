// Écran joueur.
(function () {
  const { rpc, ensureSession, syncClock, msUntil, fmtDuration, fmtTime, esc, toast, buzz, photoUrl, STATUS_LABELS, CFG, icon, elf, resizeImage } = window.W;
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
  // Texte d'un ping ouvert selon son type.
  const pingKey = p => p.kind === "chasseur" ? "ping_chasseurs" : (p.kind === "general" || p.for_all) ? "ping_general" : "ping_orga";

  const { T, line } = window.TXT;
  // Barème de la partie (fourni par le serveur) : jamais écrit en dur dans les textes.
  const pts = () => (state && state.game && state.game.points) || {};
  // Accroche + consigne. `slot` : HTML inséré à la place de {mm:ss} (minuteur en direct).
  function hookHtml(key, vars, tag, slot) {
    const t = T(key, vars);
    const c = esc(t.c).replace("{mm:ss}", slot || "");
    return `<${tag || "h2"} class="hook">${esc(t.a)}</${tag || "h2"}>${t.c ? `<p class="hint">${c}</p>` : ""}`;
  }

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
    const key = [g.status, g.round, s.target ? s.target.pseudo + "|" + s.target.photo_path + "|" + s.target.motif : "-"].join("#");
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
        ${hookHtml("connexion", null, "h1")}
        <label for="access-code">${esc(T("connexion").champ)}</label>
        <input class="code" id="access-code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" />
        <p></p>
        <button class="primary big" id="login-btn">${esc(T("connexion").bouton)}</button>
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
        // Problème de réseau : on affiche la vraie cause ; sinon le code est inconnu.
        toast(/fetch|network|réseau|connexion/i.test(e.message) ? e.message : line("connexion_erreur"), "red");
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
        ${hookHtml("attente")}
      </div>
      <div id="push-box"></div>
      <div class="card">
        <h3>Règles clés</h3>
        <ul>
          <li>Chaque joueur est à la fois <b>chasseur</b> et <b>cible</b>.</li>
          <li>Ta cible est en vue ? Appuie sur <b>Wanted !</b> : elle est prévenue et doit s'arrêter. Tu as alors <b>1 minute</b> pour la rejoindre et saisir son code (3 essais).</li>
          <li>Code bon : <b>+${esc(pts().capture)}</b> pour toi, <b>−${esc(pts().captured)}</b> pour elle. Minute écoulée : elle est <b>immunisée 2 min</b> et ton bouton est <b>bloqué 2 min</b>.</li>
          <li>Si tu es repéré, arrête-toi et montre ton code au chasseur.</li>
          <li>Aux pings, tu as <b>1 minute</b> pour appuyer sur « Envoyer ma position ». Ping manqué : <b>−${esc(pts().missed_ping)}</b>.</li>
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
        ${hookHtml("dispersion")}
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
        <div class="wanted">${esc(T("affiche").titre)}</div>
        <div class="sub">${esc(T("affiche").sous_titre)}</div>
        <div class="photo" id="target-photo">${t.photo_path ? "" : "Pas de photo"}</div>
        <div class="name">${esc(t.pseudo)}</div>
        <div class="tagline">${esc(T("affiche").sous_pseudo)}</div>
        ${window.TXT.motif(t.motif) ? `<div class="motif">${esc(T("affiche").motif + window.TXT.motif(t.motif))}</div>` : ""}
        <div class="state" id="target-state"></div>
        <div class="reward">${esc(T("affiche", { points: pts().capture }).recompense)}</div>
        <div class="footer">${esc(T("affiche").bas)}</div>
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
      if (me.out) { const h = T("hors_perimetre"); info.push(`${h.a} ${h.c}`); }
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
          ${hookHtml("saisie_code")}
          <p class="center"><span class="timer red" id="spot-left"></span> <span class="muted">pour saisir son matricule</span></p>
          <label for="capture-input">Matricule de ta cible (4 chiffres)</label>
          <input class="code" id="capture-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" />
          <p class="small" id="capture-feedback"></p>
          <button class="green big" id="capture-submit">${icon("check")} ${esc(T("saisie_code").bouton)}</button>`;
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
      const b = T("bouton_bloque", { "mm:ss": fmtDuration(lockLeft) });
      setText("wanted-info", `${b.a} · ${b.c}`);
    } else if (key === "imm") {
      btn.disabled = true;
      setText("wanted-info", `Ta cible est en pause café : ${fmtDuration(immLeft)}. Personne ne peut la balancer.`);
    } else {
      btn.disabled = false;
      setText("wanted-info", "Ta cible est en vue ? Elle sera prévenue et devra s'arrêter. Tu auras 1 minute pour saisir son code.");
    }
  }

  function updateTargetState() {
    const el = $("target-state");
    if (!el || !state.target) return;
    const left = msUntil(state.target.immune_until);
    el.innerHTML = left > 0 ? `<span class="badge green">${icon("shield")} Pause café ${fmtDuration(left)}</span>` : "";
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
        toast(line("capture_ok", { points: pts().capture }), "ok");
        screenKey = "";
        await refresh();
      } else if (r.reason === "wrong_code") {
        buzz([300]);
        const w = T("code_faux", { n: r.attempts_left });
        fb.innerHTML = `${icon("alert")} <b>${esc(w.a)}</b> · ${esc(w.c)}`;
        input.value = "";
        input.focus();
      } else {
        const msgs = {
          failed: line("reperage_rate_chasseur"),
          expired: line("reperage_rate_chasseur"),
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
      toast(T("cible_reperee").a, "red");
    }
    if (box.dataset.key !== String(sp.id)) {
      box.dataset.key = String(sp.id);
      box.className = "card alert spotted";
      box.innerHTML = `
        ${hookHtml("cible_reperee", null, "h2", `<span class="timer red" id="spotted-left"></span>`)}
        <p class="small muted">Ton code :</p>
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
        toast(line(pingKey(open)), "blue");
      }
      const key = "open" + open.id;
      if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.className = "card ping-open";
        box.innerHTML = `
          ${hookHtml(pingKey(open))}
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
      html = `<div class="center"><span class="badge green">${icon("check")} ${esc(T("ping_envoye").a)}</span>
              <p class="hint">${esc(T("ping_envoye").c)}</p></div>`;
    } else if (next && msUntil(next.scheduled_at) <= 60000) {
      key = "pre" + next.id;
      html = `${hookHtml("ping_preavis", null, "h3")}
              <p class="center"><span class="timer blue" id="ping-next"></span></p>`;
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
        toast(r.out_of_perimeter ? `${line("hors_perimetre")} (≈ ${r.distance_m} m)` : line("ping_envoye"),
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
        ${hookHtml(final ? "fin_jeu" : "regroupement")}
        <p><span class="badge gold">${icon("star")} ${esc(state.me.score_total)} points</span></p>
      </div>
      <div class="card"><h3 class="hook">${esc(T("classement_titre").a)}</h3><ol class="board" id="board"><li class="muted">Chargement…</li></ol></div>`;
    loadBoard();
  }

  async function loadBoard() {
    try {
      const rows = await rpc("get_leaderboard");
      const el = $("board");
      if (!el) return;
      const last = rows.length - 1;
      el.innerHTML = rows.map((r, i) => {
        const tag = i === 0 ? T("classement_premier").a : (i === last && last > 0 ? T("classement_dernier").a : "");
        return `<li>${esc(r.pseudo)}${tag ? ` <span class="badge ${i === 0 ? "gold" : "plain"}">${esc(tag)}</span>` : ""} <span class="pts">${esc(r.total)} pts</span></li>`;
      }).join("") || "<li>—</li>";
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
      const h = T("immunite", { "mm:ss": fmtDuration(left) });
      imm.innerHTML = left > 0 ? `<span class="badge green">${icon("shield")} ${esc(h.a)}</span><div class="small muted">${esc(h.c)}</div>` : "";
    }

    const mc = $("mycode");
    if (mc) mc.textContent = s.me.capture_code;

    const hc = $("hunters-count");
    if (hc) {
      const n = s.me.hunters || 0;
      const z = T("chasseurs_0");
      const html = n === 0
        ? `<span class="badge plain">${icon("shield")} ${esc(z.a)}</span> <span class="small muted">${esc(z.c)}</span>`
        : `<span class="badge ${n >= 2 ? "red" : "plain"}">${icon("run")} ${esc(T("chasseurs_n", { n }).a)}</span>`
          + (n >= 2 ? ` <span class="small muted">Tiens jusqu'au prochain ping chasseurs : +${esc(pts().survivor)} bonus survivant.</span>` : "");
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
      if (!chatStarted) { chatStarted = true; chat.load(true); } else chat.load(false);
      setBadge("badge-chat", "");
    } else {
      setBadge("badge-chat", (c.unread || []).length ? "•" : "");
    }
    if (tab === "quetes" && (force || (!claimOpen && Date.now() - questsLoadedAt > 10000))) loadQuests();
  }

  // ---------- Quêtes ----------

  const QUEST_STATE = {
    en_attente: `<span class="badge blue">${icon("clock")} En attente de validation</span>`,
    validee: `<span class="badge green">${icon("check")} Validée</span>`,
    refusee: `<span class="badge plain">${icon("alert")} Refusée : tu peux la redéclarer</span>`
  };
  async function loadQuests() {
    questsLoadedAt = Date.now();
    claimOpen = 0;
    proofs.clear();
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
          ${q.photo_required ? `<p class="small"><span class="badge plain">${icon("camera")} Photo obligatoire</span></p>` : ""}
          ${q.status ? `<p>${QUEST_STATE[q.status]}${q.has_photo ? ` <span class="badge plain">${icon("camera")} photo envoyée</span>` : ""}</p>` : ""}
          ${!q.status || q.status === "refusee" ? `
            <button class="green" data-quest="${q.id}">${icon("check")} J'ai réussi</button>
            <div class="claim-form hidden" data-form="${q.id}">
              <label for="qn-${q.id}">Un mot pour l'organisation (facultatif)</label>
              <textarea id="qn-${q.id}" maxlength="300" rows="2" placeholder="Comment as-tu réussi ?"></textarea>
              <label class="btn" style="margin-top:8px">${icon("camera")} ${q.photo_required ? "Prendre la photo (obligatoire)" : "Ajouter une photo (conseillé)"}
                <input type="file" accept="image/*" capture="environment" class="hidden" data-photo="${q.id}" /></label>
              <img class="proof hidden" alt="Aperçu de la photo" data-preview="${q.id}" />
              <div class="row" style="margin-top:8px">
                <button class="green" data-send="${q.id}" data-required="${q.photo_required ? 1 : 0}">${icon("send")} Envoyer la déclaration</button>
                <button data-cancel="${q.id}">Annuler</button>
              </div>
            </div>` : ""}
        </div>`).join("") || `<div class="card center"><div class="decor">${elf(2)}</div><p class="muted">Aucune quête pour l'instant. Reviens plus tard !</p></div>`;
    } catch (e) { $("quest-list").innerHTML = `<p class="muted center">${esc(e.message)}</p>`; }
  }
  // Formulaire de déclaration ouvert : on ne recharge pas la liste pour ne pas perdre la saisie.
  let claimOpen = 0;
  const proofs = new Map(); // id de quête → photo réduite (Blob)
  const form = id => document.querySelector(`[data-form="${id}"]`);
  $("quest-list").onclick = async e => {
    const open = e.target.closest("button[data-quest]");
    if (open) {
      const id = open.dataset.quest;
      open.classList.add("hidden");
      form(id).classList.remove("hidden");
      claimOpen = Number(id);
      return;
    }
    const cancel = e.target.closest("button[data-cancel]");
    if (cancel) {
      const id = cancel.dataset.cancel;
      form(id).classList.add("hidden");
      document.querySelector(`button[data-quest="${id}"]`).classList.remove("hidden");
      proofs.delete(Number(id));
      claimOpen = 0;
      return;
    }
    const b = e.target.closest("button[data-send]");
    if (!b) return;
    const id = Number(b.dataset.send);
    const photo = proofs.get(id);
    if (b.dataset.required === "1" && !photo) return toast("Ajoute d'abord la photo de preuve.", "red");
    b.disabled = true;
    try {
      let path = null;
      if (photo) {
        toast("Envoi de la photo…");
        path = await WC.uploadMedia("quests", photo, "jpg", "image/jpeg");
      }
      await rpc("claim_quest", { p_quest: id, p_note: $("qn-" + id).value.trim(), p_photo: path });
      toast("Quête déclarée : l'organisation va la valider.", "ok");
      proofs.delete(id);
      claimOpen = 0;
      await loadQuests();
    } catch (err) { toast(err.message, "red"); b.disabled = false; }
  };
  $("quest-list").onchange = async e => {
    const input = e.target.closest("input[data-photo]");
    if (!input || !input.files || !input.files[0]) return;
    const id = Number(input.dataset.photo);
    try {
      const blob = await resizeImage(input.files[0], 1400);
      proofs.set(id, blob);
      const img = document.querySelector(`[data-preview="${id}"]`);
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob);
      img.classList.remove("hidden");
    } catch (err) { toast(err.message, "red"); }
    input.value = "";
  };

  // ---------- Chat ----------

  let chatStarted = false;
  const chat = WC.mount({ list: $("chat-list"), input: $("chat-body"), send: $("chat-send"),
                          mic: $("chat-mic"), conv: $("chat-conv"), hint: $("chat-hint") }, {});

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
      const P = (next.game && next.game.points) || {};
      if (prev.me.capture_code !== next.me.capture_code) {
        buzz([500, 150, 500]);
        toast(line("capture_subie", { points: P.captured }), "red");
      }
      if (prev.spotted && !next.spotted && prev.me.capture_code === next.me.capture_code) {
        toast(line("reperage_rate_cible"), "ok");
      }
      if (prev.spot && !next.spot && next.me.locked_until && !prev.me.locked_until) {
        toast(line("reperage_rate_chasseur"), "red");
      }
      const h0 = prev.me.hunters || 0, h1 = next.me.hunters || 0;
      if (h1 > h0) {
        buzz([300, 120, 300]);
        toast(line("chasseurs_n", { n: h1 }), "red");
      }
      // Cible changée sans capture de ma part : un autre chasseur l'a eue.
      const a = prev.target && prev.target.pseudo, b = next.target && next.target.pseudo;
      if (a && b && a !== b && (next.me.captures_round || 0) <= (prev.me.captures_round || 0)) {
        buzz();
        toast(line("cible_prise_par_autre"));
      }
      // Révélation d'une position à tous par l'organisation.
      const seen = new Set((prev.public_positions || []).filter(x => x.source === "revelation").map(x => x.pseudo));
      (next.public_positions || []).filter(x => x.source === "revelation" && !seen.has(x.pseudo))
        .forEach(x => toast(line("revelation_orga", { pseudo: x.pseudo }), "blue"));
    }
    if (prev.game.status !== next.game.status) {
      buzz();
      const k = { dispersion: "dispersion", manche: "start", regroupement: "fin_manche", termine: "fin_jeu" }[next.game.status];
      if (k) toast(line(k), k === "start" ? "red" : "");
    }
    // Points gagnés ou perdus en fin de manche : ping manqué, bonus survivant.
    const prevMax = Math.max(0, ...((prev.me.last_scores || []).map(x => x.id)));
    (next.me.last_scores || []).filter(x => x.id > prevMax).forEach(x => {
      if (x.reason === "ping manqué") toast(line("ping_manque", { points: Math.abs(x.points) }), "red");
      if (x.reason === "bonus survivant") toast(line("bonus_survivant", { points: x.points }), "ok");
    });
    const newest = next.messages && next.messages[0];
    if (newest && lastMsgId !== null && newest.id !== lastMsgId) {
      buzz();
      toast(line("message_orga", { texte: newest.body }), "blue");
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
