// Écran organisateur.
(function () {
  const { sb, rpc, ensureSession, syncClock, msUntil, fmtDuration, fmtTime, esc, toast, photoUrl, resizeImage, randomName, STATUS_LABELS, icon } = window.W;
  const W = window.W, WG = window.WG;
  const $ = id => document.getElementById(id);

  let data = null;
  let photoTarget = null;

  const LOG_LABELS = {
    tirage: d => `Tirage de la manche ${d.manche} (${d.joueurs} joueurs)`,
    tirage_impossible: d => `Tirage impossible : ${d.joueurs} joueur(s) actif(s)`,
    debut_manche: d => `START manche ${d.manche}`,
    fin_manche: d => `Fin de la manche ${d.manche}`,
    dispersion: d => `Dispersion manche ${d.manche}`,
    capture: d => `${d.chasseur} a trouvé ${d.cible} (${d.chasseurs_reattribues} chasseur(s) réattribué(s))`,
    capture_annulee: d => `Capture n° ${d.capture} annulée`,
    correction_points: d => `${d.joueur} : ${d.points > 0 ? "+" : ""}${d.points} (${d.motif})`,
    reattribution: d => `Nouvelle cible pour ${d.chasseur}`,
    joueur_cree: d => `Joueur créé : ${d.joueur}`,
    connexion: d => `${d.joueur} s'est connecté`,
    connexion_organisateur: () => "Connexion organisateur",
    statut: d => `Statut : ${STATUS_LABELS[d.statut] || d.statut}`,
    reinitialisation: () => "Partie réinitialisée",
    repere: d => `${d.chasseur} a repéré ${d.cible} (1 min pour le code)`,
    repere_echoue: d => `Repérage raté : ${d.chasseur} → ${d.cible} (immunité et blocage 2 min)`,
    hors_perimetre: d => `Hors zone : ${d.joueur} hors du périmètre (≈ ${d.distance_m} m)`,
    ping_manuel: d => `Position demandée : ${d.joueur}`,
    revelation: d => `Position de ${d.joueur} révélée (${d.portee})`,
    score_manche: d => `Pénalités de ping et bonus survivant calculés (manche ${d.manche})`,
    purge: () => "Photos et positions purgées"
  };

  // ---------- Connexion ----------

  async function login() {
    const code = $("org-code").value.trim();
    if (!code) return;
    try {
      await ensureSession();
      await rpc("claim_organizer", { p_code: code });
      await refresh();
    } catch (e) { toast(e.message, "red"); }
  }
  $("org-login").onclick = login;
  $("org-code").onkeydown = e => { if (e.key === "Enter") login(); };

  // ---------- Rendu ----------

  function render() {
    $("login").classList.add("hidden");
    $("dash").classList.remove("hidden");
    const g = data.game;
    $("g-status").textContent = STATUS_LABELS[g.status] + (g.round ? ` · manche ${g.round}` : "");
    $("g-detail").textContent =
      g.status === "dispersion" ? `START à ${fmtTime(g.start_at)}, fin à ${fmtTime(g.end_at)}` :
      g.status === "manche" ? `Démarrée à ${fmtTime(g.start_at)}, fin à ${fmtTime(g.end_at)}` : "";

    const ps = data.players;
    $("p-count").textContent = `(${ps.filter(p => p.active).length} actifs, ${ps.filter(p => p.linked).length} connectés)`;
    $("players").innerHTML = ps.map(p => `
      <tr data-id="${esc(p.id)}" style="${p.active ? "" : "opacity:.5"}">
        <td><img class="thumb" data-photo="${esc(p.photo_path || "")}" alt="" /></td>
        <td><b>${esc(p.pseudo)}</b></td>
        <td class="mono">${esc(p.access_code)} ${p.linked ? `<span class="badge plain">${icon("check")} lié</span>` : ""}</td>
        <td class="mono">${esc(p.capture_code)}</td>
        <td>${esc(p.score_total)}</td>
        <td>${esc(p.score_round)}</td>
        <td>${esc(p.target || "—")}</td>
        <td>${esc(p.hunters)}</td>
        <td class="small">${p.last_position ? `${esc(fmtTime(p.last_position.sent_at))}${p.last_position.out ? ` <span class="badge red">${icon("alert")} hors zone ${Math.round(p.last_position.distance_out_m || 0)} m</span>` : ""}` : "—"}${p.out_count > 1 ? ` <span class="small muted">(${p.out_count}× hors zone)</span>` : ""}</td>
        <td>${p.spotted ? `<span class="badge red">${icon("stop")} repéré</span> ` : ""}${msUntil(p.immune_until) > 0 ? `<span class="badge green">${icon("shield")} immunisé</span> ` : ""}${msUntil(p.cooldown_until) > 0 ? `<span class="badge plain">${icon("lock")} Wanted bloqué</span> ` : ""}${p.active ? "" : `<span class="badge plain">${icon("lock")} inactif</span>`}</td>
        <td class="row" style="gap:4px;flex-wrap:nowrap">
          <button class="small" data-a="photo">Photo</button>
          <button class="small" data-a="ping">Ping</button>
          <button class="small" data-a="reveal-h">Révéler ch.</button>
          <button class="small" data-a="reveal-all">Révéler tous</button>
          <button class="small" data-a="points">± pts</button>
          <button class="small" data-a="reassign">Réattr.</button>
          <button class="small" data-a="code">Nv accès</button>
          <button class="small" data-a="toggle">${p.active ? "Désact." : "Activer"}</button>
          <button class="small danger" data-a="delete">Suppr.</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="11" class="muted">Aucun joueur.</td></tr>`;

    renderPings();
    renderMap();

    document.querySelectorAll("img[data-photo]").forEach(async img => {
      const url = await photoUrl(img.dataset.photo);
      if (url) img.src = url; else img.removeAttribute("src");
    });

    const sel = $("msg-to");
    const keep = sel.value;
    sel.innerHTML = `<option value="">Tout le monde</option>` +
      ps.map(p => `<option value="${esc(p.id)}">${esc(p.pseudo)}</option>`).join("");
    sel.value = keep;

    $("captures").innerHTML = data.captures.map(c => `
      <div class="row" style="${c.cancelled ? "text-decoration:line-through;opacity:.6" : ""}">
        <span class="grow">${esc(fmtTime(c.created_at))} · M${esc(c.round)} · <b>${esc(c.hunter)}</b> → ${esc(c.target)}</span>
        ${c.cancelled ? "" : `<button class="small danger" data-cancel="${esc(c.id)}">Annuler</button>`}
      </div>`).join("") || `<div class="muted">Aucune capture.</div>`;

    $("log").innerHTML = data.log.map(l => {
      const f = LOG_LABELS[l.kind];
      return `<div>${esc(fmtTime(l.created_at))} · ${esc(f ? f(l.detail || {}) : l.kind)}</div>`;
    }).join("") || `<div class="muted">Rien pour l'instant.</div>`;

    tick();
  }

  const PING_LABELS = { chasseur: "Chasseurs", general: "Général", manuel: "Manuel" };

  function renderPings() {
    const t = W.now();
    $("pings").innerHTML = (data.pings || []).map(p => {
      const start = new Date(p.scheduled_at).getTime(), end = new Date(p.window_end).getTime();
      const st = t < start ? "à venir" : t <= end ? "<b>en cours</b>" : "terminé";
      return `<div>${esc(fmtTime(p.scheduled_at))} · ${esc(PING_LABELS[p.kind])}${p.for_player ? " (" + esc(p.for_player) + ")" : ""} · ${st} · ${esc(p.sent)}/${esc(p.expected)} envoyé(s)</div>`;
    }).join("") || `<div class="muted">Les pings sont créés au START.</div>`;
  }

  let mapObj = null;
  function renderMap() {
    if (!mapObj) mapObj = WG.createMap($("org-map"));
    const { layer } = mapObj;
    layer.clearLayers();
    data.players.forEach(p => {
      const lp = p.last_position;
      if (!lp) return;
      const old = W.now() - new Date(lp.sent_at).getTime() > 20 * 60 * 1000;
      const color = lp.out ? "#8E1F2C" : old ? "#5C5248" : "#1E3A5F";
      WG.label(WG.dot([lp.lat, lp.lng], { fillColor: color }).addTo(layer),
        `<b>${esc(p.pseudo)}</b> ${esc(fmtTime(lp.sent_at))}${lp.accuracy ? ` ±${Math.round(lp.accuracy)} m` : ""}${lp.out ? " · hors zone" : old ? " · ancienne" : ""}`, true);
    });
  }

  function tick() {
    if (!data) return;
    const g = data.game;
    let txt = "";
    if (g.status === "dispersion") txt = `START dans ${fmtDuration(msUntil(g.start_at))}`;
    else if (g.status === "manche") txt = `Fin dans ${fmtDuration(msUntil(g.end_at))}`;
    $("g-timer").textContent = txt;
    if ((g.status === "dispersion" && msUntil(g.start_at) <= 0) || (g.status === "manche" && msUntil(g.end_at) <= 0)) {
      if (!tick.pending) { tick.pending = true; setTimeout(() => { tick.pending = false; refresh(); }, 800); }
    }
  }

  // ---------- Actions de partie ----------

  async function act(name, args, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try { await rpc(name, args); await refresh(); }
    catch (e) { toast(e.message, "red"); }
  }

  document.querySelectorAll("[data-act]").forEach(btn => {
    btn.onclick = () => {
      const a = btn.dataset.act;
      if (a === "disp1") act("org_start_dispersion", { p_round: 1 }, "Lancer la dispersion de la manche 1 ? Le tirage aura lieu dans 10 min.");
      if (a === "disp2") act("org_start_dispersion", { p_round: 2 }, "Lancer la dispersion de la manche 2 ? Nouveau tirage dans 10 min.");
      if (a === "draw") act("org_draw_now", {}, "Tirer les cibles et lancer la manche maintenant ?");
      if (a === "end") act("org_end_round", {}, "Terminer la manche maintenant ?");
      if (a === "regroup") act("org_set_status", { p_status: "regroupement" });
      if (a === "finish") act("org_set_status", { p_status: "termine" }, "Afficher le classement final aux joueurs ?");
      if (a === "welcome") act("org_set_status", { p_status: "accueil" });
      if (a === "reset") act("org_reset", {}, "Tout réinitialiser ? Captures, scores, cibles, pings, positions, messages et journal seront effacés. Les joueurs et les photos sont conservés.");
      if (a === "pingall") act("org_request_position", { p_player: null }, "Demander leur position à tous les joueurs ? Ils auront 1 minute (−3 s'ils ne l'envoient pas).");
      if (a === "purge") purge();
    };
  });

  // ---------- Joueurs ----------

  $("add-player").onclick = async () => {
    const pseudo = $("new-pseudo").value.trim();
    if (!pseudo) return;
    try {
      const r = await rpc("org_create_player", { p_pseudo: pseudo });
      $("new-pseudo").value = "";
      toast(`${r.pseudo} créé. Code d'accès : ${r.access_code}`, "ok");
      await refresh();
    } catch (e) { toast(e.message, "red"); }
  };
  $("new-pseudo").onkeydown = e => { if (e.key === "Enter") $("add-player").click(); };

  $("players").onclick = async e => {
    const btn = e.target.closest("button[data-a]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    const p = data.players.find(x => x.id === id);
    const a = btn.dataset.a;
    if (a === "photo") { photoTarget = p; $("photo-input").value = ""; $("photo-input").click(); }
    if (a === "points") {
      const pts = parseInt(prompt(`Points à ajouter pour ${p.pseudo} (négatif pour retirer) :`, "-1"), 10);
      if (!pts) return;
      const reason = prompt("Motif (obligatoire) :", "");
      if (!reason) return;
      act("org_adjust_points", { p_player: id, p_points: pts, p_reason: reason });
    }
    if (a === "ping") act("org_request_position", { p_player: id }, `Demander sa position à ${p.pseudo} ? 1 minute pour l'envoyer.`);
    if (a === "reveal-h") act("org_reveal_position", { p_player: id, p_scope: "chasseurs" }, `Révéler la dernière position de ${p.pseudo} à ses chasseurs ?`);
    if (a === "reveal-all") act("org_reveal_position", { p_player: id, p_scope: "tous" }, `Révéler la dernière position de ${p.pseudo} à tous les joueurs ?`);
    if (a === "reassign") act("org_reassign", { p_hunter: id, p_target: null }, `Donner une nouvelle cible au hasard à ${p.pseudo} ?`);
    if (a === "code") {
      if (!confirm(`Générer un nouveau code d'accès pour ${p.pseudo} ? Son téléphone sera déconnecté.`)) return;
      try { const c = await rpc("org_regenerate_access_code", { p_id: id }); toast(`Nouveau code : ${c}`, "ok"); await refresh(); }
      catch (err) { toast(err.message, "red"); }
    }
    if (a === "toggle") act("org_update_player", { p_id: id, p_pseudo: null, p_active: !p.active });
    if (a === "delete") {
      if (!confirm(`Supprimer définitivement ${p.pseudo} ?`)) return;
      try {
        const path = await rpc("org_delete_player", { p_id: id });
        if (path) await sb.storage.from("photos").remove([path]);
        await refresh();
      } catch (err) { toast(err.message, "red"); }
    }
  };

  $("photo-input").onchange = async () => {
    const file = $("photo-input").files[0];
    const p = photoTarget;
    if (!file || !p) return;
    try {
      toast(`Envoi de la photo de ${p.pseudo}…`);
      const blob = await resizeImage(file, 900);
      const path = randomName("jpg");
      const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const old = await rpc("org_set_photo", { p_id: p.id, p_path: path });
      if (old) await sb.storage.from("photos").remove([old]);
      toast("Photo enregistrée.", "ok");
      await refresh();
    } catch (e) { toast(e.message, "red"); }
  };

  async function purge() {
    if (!confirm("Purger les données ? Toutes les photos et toutes les positions seront supprimées définitivement. Les scores sont conservés.")) return;
    if (!confirm("Confirmer la suppression définitive des photos et des positions ?")) return;
    try {
      const paths = await rpc("org_purge");
      // Supprime aussi les fichiers orphelins éventuels du bucket.
      const listed = await sb.storage.from("photos").list("", { limit: 1000 });
      const all = new Set([...(paths || []), ...((listed.data || []).map(o => o.name))]);
      if (all.size) {
        const rm = await sb.storage.from("photos").remove([...all]);
        if (rm.error) throw rm.error;
      }
      toast(`Purge terminée : ${all.size} photo(s) et toutes les positions supprimées.`, "ok");
      await refresh();
    } catch (e) { toast(e.message, "red"); }
  }

  // ---------- Messages, captures, export ----------

  $("msg-send").onclick = async () => {
    const body = $("msg-body").value.trim();
    if (!body) return;
    try {
      await rpc("org_send_message", { p_player: $("msg-to").value || null, p_body: body });
      $("msg-body").value = "";
      toast("Message envoyé.", "ok");
    } catch (e) { toast(e.message, "red"); }
  };

  $("captures").onclick = e => {
    const btn = e.target.closest("button[data-cancel]");
    if (btn) act("org_cancel_capture", { p_capture: Number(btn.dataset.cancel) }, "Annuler cette capture ? Les points seront rendus.");
  };

  $("export-csv").onclick = async () => {
    try {
      const rows = await rpc("get_leaderboard");
      const lines = [["Rang", "Pseudo", "Total", "Manche 1", "Manche 2", "Captures"].join(";")]
        .concat(rows.map((r, i) => [i + 1, `"${String(r.pseudo).replace(/"/g, '""')}"`, r.total, r.round1, r.round2, r.captures].join(";")));
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "wanted-classement.csv";
      a.click();
    } catch (e) { toast(e.message, "red"); }
  };

  // ---------- Synchronisation ----------

  async function refresh() {
    try {
      await ensureSession();
      data = await rpc("org_get_overview");
      syncClock(data.server_now);
      render();
    } catch (e) {
      if (/organisateur/i.test(e.message)) {
        $("dash").classList.add("hidden");
        $("login").classList.remove("hidden");
      } else {
        toast(e.message, "red");
      }
    }
  }

  setInterval(refresh, 5000);
  setInterval(tick, 1000);
  refresh();
})();
