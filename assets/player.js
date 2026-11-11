// Écran joueur.
(function () {
  const { rpc, ensureSession, syncClock, msUntil, fmtDuration, fmtTime, esc, toast, buzz, photoUrl, STATUS_LABELS, CFG } = window.W;

  const app = document.getElementById("app");
  const who = document.getElementById("who");
  const modal = document.getElementById("capture-modal");
  const capInput = document.getElementById("capture-input");
  const capFeedback = document.getElementById("capture-feedback");
  const capSubmit = document.getElementById("capture-submit");

  let state = null;
  let screenKey = "";
  let busy = false;
  let lastMsgId = null;
  let codeHideTimer = null;

  // ---------- Rendu ----------

  function render() {
    const s = state;
    if (!s || !s.me) { if (screenKey !== "login") renderLogin(); return; }

    who.innerHTML = `${esc(s.me.pseudo)}<br><span class="small">${esc(STATUS_LABELS[s.game.status] || "")}${s.game.round ? " · manche " + s.game.round : ""}</span>`;
    renderMessages();

    const g = s.game;
    const key = [g.status, g.round, s.target ? s.target.pseudo + "|" + s.target.photo_path : "-"].join("#");
    if (key !== screenKey) {
      screenKey = key;
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
    document.getElementById("messages").classList.add("hidden");
    app.innerHTML = `
      <div class="card center">
        <h1>Avis de recherche</h1>
        <p class="muted">Entre le code personnel remis par l'organisation.</p>
        <input class="code" id="access-code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" />
        <p></p>
        <button class="primary big" id="login-btn">Entrer</button>
      </div>`;
    const input = document.getElementById("access-code");
    const go = async () => {
      const code = input.value.trim();
      if (!code) return;
      const btn = document.getElementById("login-btn");
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
    document.getElementById("login-btn").onclick = go;
    input.onkeydown = e => { if (e.key === "Enter") go(); };
  }

  function renderWaiting() {
    app.innerHTML = `
      <div class="card">
        <h2>En attente du départ</h2>
        <p>Tu es inscrit. L'organisation lancera bientôt la dispersion.</p>
      </div>
      <div class="card">
        <h3>Règles clés</h3>
        <ul class="small">
          <li>Chaque joueur est à la fois <b>chasseur</b> et <b>cible</b>.</li>
          <li>Trouve ta cible et saisis le code à 4 chiffres de son téléphone : <b>+3</b> pour toi, <b>−2</b> pour elle.</li>
          <li>Si on te trouve, tu montres ton code. Tu reçois un nouveau code et <b>2 min d'immunité</b>.</li>
          <li>Garde cette page ouverte et le son activé pendant la partie.</li>
        </ul>
      </div>`;
  }

  function renderDispersion() {
    app.innerHTML = `
      <div class="card center">
        <h2>Dispersion</h2>
        <p class="muted">Éloigne-toi. Ta cible sera révélée au START.</p>
        <div class="countdown" data-until="${esc(state.game.start_at)}" data-refresh-at-zero="1">--:--</div>
        <p class="small muted">START à ${esc(fmtTime(state.game.start_at))}</p>
      </div>`;
  }

  function renderRound() {
    const t = state.target;
    app.innerHTML = `
      <div class="card">
        <div class="row">
          <div class="grow"><span class="muted small">Fin de manche dans</span><br><span class="timer" data-until="${esc(state.game.end_at)}" data-refresh-at-zero="1">--:--</span></div>
          <div id="immunity"></div>
        </div>
      </div>
      ${t ? `
      <div class="poster card">
        <div class="wanted">WANTED</div>
        <div class="sub">MORT OU VIF · MANCHE ${esc(state.game.round)}</div>
        <div class="photo" id="target-photo">${t.photo_path ? "" : "Pas de photo"}</div>
        <div class="name">${esc(t.pseudo)}</div>
      </div>
      <button class="primary big" id="wanted-btn">Wanted !</button>
      <p class="small center muted" id="lock-info"></p>` : `
      <div class="card center"><p>Aucune cible pour le moment. Patiente un instant…</p></div>`}
      <div class="card">
        <div class="scores">
          <div><div class="v" id="sc-round">0</div><div class="k">Manche</div></div>
          <div><div class="v" id="sc-total">0</div><div class="k">Total</div></div>
          <div><div class="v" id="sc-caps">0</div><div class="k">Captures</div></div>
        </div>
      </div>
      <div class="card center">
        <button class="big" id="show-code">Afficher mon code</button>
        <div class="mycode hidden" id="mycode"></div>
        <p class="small muted hidden" id="mycode-hint">Montre-le seulement au chasseur qui t'a trouvé. Masqué dans 15 s.</p>
      </div>`;

    if (t && t.photo_path) {
      photoUrl(t.photo_path).then(url => {
        const el = document.getElementById("target-photo");
        if (el && url) el.style.backgroundImage = `url("${url}")`;
      });
    }
    const wb = document.getElementById("wanted-btn");
    if (wb) wb.onclick = openCapture;
    document.getElementById("show-code").onclick = toggleCode;
  }

  async function renderBoard() {
    const final = state.game.status === "termine";
    app.innerHTML = `
      <div class="card center">
        <h2>${final ? "Classement final" : "Regroupement"}</h2>
        <p class="muted">${final ? "Merci d'avoir joué !" : `Fin de la manche ${esc(state.game.round)}. Rejoins le point de rendez-vous.`}</p>
        <p><span class="stamp">${esc(state.me.score_total)} pts</span></p>
      </div>
      <div class="card"><ol class="board" id="board"><li class="muted">Chargement…</li></ol></div>`;
    loadBoard();
  }

  async function loadBoard() {
    try {
      const rows = await rpc("get_leaderboard");
      const el = document.getElementById("board");
      if (!el) return;
      el.innerHTML = rows.map(r => `<li>${esc(r.pseudo)} <span class="pts">${esc(r.total)}</span></li>`).join("") || "<li>—</li>";
    } catch (e) { /* on réessaiera au prochain rafraîchissement */ }
  }

  function renderMessages() {
    const box = document.getElementById("messages");
    const list = state.messages || [];
    box.classList.toggle("hidden", list.length === 0);
    document.getElementById("msg-list").innerHTML = list.map(m =>
      `<li><div class="t">${esc(fmtTime(m.created_at))}${m.private ? " · pour toi" : ""}</div>${esc(m.body)}</li>`).join("");
  }

  // Mise à jour des éléments qui changent sans tout redessiner.
  function updateLive() {
    const s = state;
    if (!s || !s.me) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("sc-round", s.me.score_round);
    set("sc-total", s.me.score_total);
    set("sc-caps", s.me.captures_round);

    const imm = document.getElementById("immunity");
    if (imm) {
      const left = msUntil(s.me.immune_until);
      imm.innerHTML = left > 0 ? `<span class="badge ok">Immunité ${fmtDuration(left)}</span>` : "";
    }

    const lockLeft = msUntil(s.me.locked_until);
    const wb = document.getElementById("wanted-btn");
    if (wb) wb.disabled = lockLeft > 0;
    set("lock-info", lockLeft > 0 ? `Trop de codes faux : saisie bloquée ${fmtDuration(lockLeft)}` : "");

    const mc = document.getElementById("mycode");
    if (mc) mc.textContent = s.me.capture_code;

    let needRefresh = false;
    document.querySelectorAll("[data-until]").forEach(el => {
      const left = msUntil(el.dataset.until);
      el.textContent = fmtDuration(left);
      if (left <= 0 && el.dataset.refreshAtZero === "1") { el.dataset.refreshAtZero = "0"; needRefresh = true; }
    });
    if (needRefresh) setTimeout(refresh, 800);
  }

  function toggleCode() {
    const mc = document.getElementById("mycode");
    const hint = document.getElementById("mycode-hint");
    const btn = document.getElementById("show-code");
    const show = mc.classList.contains("hidden");
    mc.classList.toggle("hidden", !show);
    hint.classList.toggle("hidden", !show);
    btn.textContent = show ? "Masquer mon code" : "Afficher mon code";
    clearTimeout(codeHideTimer);
    if (show) codeHideTimer = setTimeout(() => { if (!mc.classList.contains("hidden")) toggleCode(); }, 15000);
  }

  // ---------- Capture ----------

  function openCapture() {
    capInput.value = "";
    capFeedback.textContent = "";
    capSubmit.disabled = false;
    modal.classList.remove("hidden");
    setTimeout(() => capInput.focus(), 50);
  }
  function closeCapture() { modal.classList.add("hidden"); }

  async function submitCapture() {
    const code = capInput.value.replace(/\D/g, "");
    if (code.length !== 4) { capFeedback.textContent = "Le code fait 4 chiffres."; return; }
    if (busy) return;
    busy = true;
    capSubmit.disabled = true;
    try {
      const r = await rpc("submit_capture", { p_code: code });
      if (r.ok) {
        closeCapture();
        buzz([100, 60, 100, 60, 300]);
        toast(`${r.captured} est tombé ! +3. Nouvelle cible : ${r.new_target || "…"}`, "ok");
        screenKey = "";
        await refresh();
      } else {
        const msgs = {
          wrong_code: `Code faux.${r.attempts_left > 0 ? ` Encore ${r.attempts_left} essai(s) avant blocage.` : ""}`,
          locked: "Trop de codes faux : saisie bloquée 2 minutes.",
          immune: "Ta cible vient d'être trouvée : elle est immunisée pour l'instant.",
          target_changed: "Ta cible a changé. Regarde ta nouvelle fiche.",
          no_target: "Tu n'as pas de cible pour le moment.",
          not_running: "La manche n'est pas en cours."
        };
        capFeedback.textContent = msgs[r.reason] || "Refusé.";
        if (r.reason === "wrong_code") buzz([300]);
        if (r.reason !== "wrong_code") { setTimeout(closeCapture, 2500); screenKey = ""; }
        await refresh();
      }
    } catch (e) {
      capFeedback.textContent = e.message;
    } finally {
      busy = false;
      capSubmit.disabled = false;
    }
  }

  document.getElementById("capture-cancel").onclick = closeCapture;
  capSubmit.onclick = submitCapture;
  capInput.onkeydown = e => { if (e.key === "Enter") submitCapture(); };

  // ---------- Synchronisation ----------

  function detectEvents(prev, next) {
    if (!prev || !prev.me || !next.me) return;
    if (prev.game.status === "manche" && next.game.status === "manche") {
      if (prev.me.capture_code !== next.me.capture_code) {
        buzz([500, 150, 500]);
        toast("On t'a trouvé ! −2. Nouveau code et 2 min d'immunité.", "red");
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
      toast(`Message : ${newest.body}`);
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
      if (["regroupement", "termine"].includes(next.game.status) && next.me) loadBoard();
    } catch (e) {
      if (!state) app.innerHTML = `<div class="card center"><p>Connexion impossible.</p><p class="small muted">${esc(e.message)}</p><button id="retry">Réessayer</button></div>`;
      const r = document.getElementById("retry");
      if (r) r.onclick = refresh;
    }
  }

  setInterval(refresh, CFG.POLL_INTERVAL_MS || 10000);
  setInterval(updateLive, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  refresh();
})();
