// Écran organisateur : onglets Partie, Joueurs, Classement, Quêtes, Chat.
(function () {
  const { sb, rpc, ensureSession, syncClock, msUntil, fmtDuration, fmtTime, esc, toast, photoUrl, resizeImage, randomName, STATUS_LABELS, icon } = window.W;
  const W = window.W, WG = window.WG, WC = window.WC;
  const $ = id => document.getElementById(id);

  let data = null;
  let photoTarget = null;
  let tab = "partie";

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
    import_joueurs: d => `Import : ${d.crees} joueur(s) créé(s), ${d.ignores} ignoré(s)`,
    connexion: d => `${d.joueur} s'est connecté`,
    deconnexion: d => `${d.joueur} s'est déconnecté`,
    connexion_organisateur: () => "Connexion organisateur",
    statut: d => `Statut : ${STATUS_LABELS[d.statut] || d.statut}`,
    reinitialisation: () => "Partie réinitialisée",
    repere: d => `${d.chasseur} a repéré ${d.cible} (1 min pour le code)`,
    repere_echoue: d => `Repérage raté : ${d.chasseur} → ${d.cible} (immunité et blocage 2 min)`,
    hors_perimetre: d => `Hors zone : ${d.joueur} hors du périmètre (≈ ${d.distance_m} m)`,
    ping_manuel: d => `Position demandée : ${d.joueur}`,
    revelation: d => `Position de ${d.joueur} révélée (${d.portee})`,
    score_manche: d => `Pénalités de ping et bonus survivant calculés (manche ${d.manche})`,
    quete_declaree: d => `${d.joueur} déclare la quête « ${d.quete} »`,
    quete: d => `Quête « ${d.quete} » ${d.decision} pour ${d.joueur}`,
    chat: d => `Chat ${d.ouvert ? "ouvert" : "fermé"}`,
    purge: () => "Photos, positions et chat purgés"
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
  $("logout").onclick = () => {
    if (confirm("Te déconnecter de l'organisation sur cet appareil ? Il faudra le code organisateur pour revenir.")) W.logout();
  };

  // ---------- Onglets ----------

  function showTab(name) {
    tab = name;
    try { localStorage.setItem("wanted-org-tab", name); } catch (e) { /* ignoré */ }
    document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== name));
    if (name === "partie" && mapObj) setTimeout(() => mapObj.map.invalidateSize(), 50);
    loadTab();
  }
  $("tabs").onclick = e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); };

  function loadTab() {
    if (!data) return;
    if (tab === "classement") loadScoreboard();
    if (tab === "quetes") loadQuests();
    if (tab === "chat") chat.load(false).then(() => WC.setSeen("wanted-chat-seen-org", chat.st.lastId));
  }

  function setBadge(id, n, label) {
    const el = $(id);
    el.textContent = n > 0 ? (label || String(n)) : "";
    el.classList.toggle("hidden", !(n > 0));
  }

  // ---------- Rendu (onglets Partie et Joueurs) ----------

  function render() {
    $("login").classList.add("hidden");
    $("dash").classList.remove("hidden");
    $("logout").classList.remove("hidden");
    const g = data.game;
    $("g-status").textContent = STATUS_LABELS[g.status] + (g.round ? ` · manche ${g.round}` : "");
    $("g-detail").textContent =
      g.status === "dispersion" ? `START à ${fmtTime(g.start_at)}, fin à ${fmtTime(g.end_at)}` :
      g.status === "manche" ? `Démarrée à ${fmtTime(g.start_at)}, fin à ${fmtTime(g.end_at)}` : "";

    const ps = data.players;
    $("p-count").textContent = `(${ps.filter(p => p.active).length} actifs, ${ps.filter(p => p.linked).length} connectés, ${ps.filter(p => p.push_devices > 0).length} avec notifications)`;
    $("players").innerHTML = ps.map(p => `
      <tr data-id="${esc(p.id)}" style="${p.active ? "" : "opacity:.5"}">
        <td><img class="thumb" data-photo="${esc(p.photo_path || "")}" alt="" /></td>
        <td><b>${esc(p.pseudo)}</b></td>
        <td>${esc(p.full_name || "—")}</td>
        <td class="mono">${esc(p.access_code)} ${p.linked ? `<span class="badge plain">${icon("check")} lié</span>` : ""}</td>
        <td class="mono">${esc(p.capture_code)}</td>
        <td>${esc(p.target || "—")}</td>
        <td>${esc(p.hunters)}</td>
        <td class="small">${p.last_position ? `${esc(fmtTime(p.last_position.sent_at))}${p.last_position.out ? ` <span class="badge red">${icon("alert")} hors zone ${Math.round(p.last_position.distance_out_m || 0)} m</span>` : ""}` : "—"}${p.out_count > 1 ? ` <span class="small muted">(${p.out_count}× hors zone)</span>` : ""}</td>
        <td>${p.push_devices > 0 ? `<span class="badge green">${icon("check")} notif</span> ` : `<span class="badge plain">${icon("alert")} sans notif</span> `}${p.spotted ? `<span class="badge red">${icon("stop")} repéré</span> ` : ""}${msUntil(p.immune_until) > 0 ? `<span class="badge green">${icon("shield")} immunisé</span> ` : ""}${msUntil(p.cooldown_until) > 0 ? `<span class="badge plain">${icon("lock")} Wanted bloqué</span> ` : ""}${p.active ? "" : `<span class="badge plain">${icon("lock")} inactif</span>`}</td>
        <td class="row" style="gap:4px;flex-wrap:nowrap">
          <button class="small" data-a="photo">Photo</button>
          <button class="small" data-a="name">Nom</button>
          <button class="small" data-a="ping">Ping</button>
          <button class="small" data-a="reveal-h">Révéler ch.</button>
          <button class="small" data-a="reveal-all">Révéler tous</button>
          <button class="small" data-a="points">± pts</button>
          <button class="small" data-a="reassign">Réattr.</button>
          <button class="small" data-a="code">Nv accès</button>
          <button class="small" data-a="toggle">${p.active ? "Désact." : "Activer"}</button>
          <button class="small danger" data-a="delete">Suppr.</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="10" class="muted">Aucun joueur.</td></tr>`;

    renderPings();
    renderMap();

    document.querySelectorAll("img[data-photo]").forEach(async img => {
      const url = await photoUrl(img.dataset.photo);
      if (url) img.src = url; else img.removeAttribute("src");
    });

    fillPlayerSelect($("msg-to"));
    fillPlayerSelect($("q-player"));

    $("captures").innerHTML = data.captures.map(c => `
      <div class="row" style="${c.cancelled ? "text-decoration:line-through;opacity:.6" : ""}">
        <span class="grow">${esc(fmtTime(c.created_at))} · M${esc(c.round)} · <b>${esc(c.hunter)}</b> → ${esc(c.target)}</span>
        ${c.cancelled ? "" : `<button class="small danger" data-cancel="${esc(c.id)}">Annuler</button>`}
      </div>`).join("") || `<div class="muted">Aucune capture.</div>`;

    $("log").innerHTML = data.log.map(l => {
      const f = LOG_LABELS[l.kind];
      return `<div>${esc(fmtTime(l.created_at))} · ${esc(f ? f(l.detail || {}) : l.kind)}</div>`;
    }).join("") || `<div class="muted">Rien pour l'instant.</div>`;

    setBadge("badge-quetes", data.claims_pending);
    setBadge("badge-chat", tab !== "chat" && (data.chat_last_id || 0) > WC.getSeen("wanted-chat-seen-org") ? 1 : 0, "nouveau");
    renderChatState(data.chat_enabled);

    tick();
  }

  function fillPlayerSelect(sel) {
    const keep = sel.value;
    sel.innerHTML = `<option value="">Tout le monde</option>` +
      data.players.map(p => `<option value="${esc(p.id)}">${esc(p.pseudo)}</option>`).join("");
    sel.value = keep;
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
      if (a === "reset") act("org_reset", {}, "Tout réinitialiser ? Captures, scores, cibles, pings, positions, messages, chat, déclarations de quêtes et journal seront effacés. Les joueurs, les photos et les quêtes sont conservés.");
      if (a === "pingall") act("org_request_position", { p_player: null }, "Ping tous les joueurs ? Chacun reçoit une notification et a 1 minute pour envoyer sa position (−3 s'il ne l'envoie pas). Les positions reçues s'affichent sur ta carte et sur celle de tous les joueurs.");
      if (a === "purge") purge();
      if (a === "testpush") testPush();
    };
  });

  async function testPush() {
    try {
      const n = await rpc("org_test_push", { p_player: null });
      toast(n ? `Notification de test envoyée à ${n} téléphone(s).` : "Aucun téléphone n'a encore activé les notifications.", n ? "ok" : "red");
    } catch (e) { toast(e.message, "red"); }
  }

  // ---------- Joueurs ----------

  $("add-player").onclick = async () => {
    const pseudo = $("new-pseudo").value.trim();
    if (!pseudo) return;
    try {
      const r = await rpc("org_import_players", { p_rows: [{ pseudo, nom: $("new-name").value.trim() }] });
      if (!r.created.length) throw new Error(`Pseudo « ${pseudo} » : ${r.skipped[0] ? r.skipped[0].motif : "refusé"}.`);
      $("new-pseudo").value = ""; $("new-name").value = "";
      toast(`${r.created[0].pseudo} créé. Code d'accès : ${r.created[0].access_code}`, "ok");
      await refresh();
    } catch (e) { toast(e.message, "red"); }
  };
  $("new-pseudo").onkeydown = e => { if (e.key === "Enter") $("add-player").click(); };
  $("new-name").onkeydown = e => { if (e.key === "Enter") $("add-player").click(); };

  $("players").onclick = async e => {
    const btn = e.target.closest("button[data-a]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    const p = data.players.find(x => x.id === id);
    const a = btn.dataset.a;
    if (a === "photo") { photoTarget = p; $("photo-input").value = ""; $("photo-input").click(); }
    if (a === "name") {
      const n = prompt(`Nom de ${p.pseudo} (visible seulement par l'organisation) :`, p.full_name || "");
      if (n !== null) act("org_set_full_name", { p_id: id, p_name: n });
    }
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

  // ---------- Import Excel ----------

  let importRows = null;
  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error("Lecteur Excel indisponible (connexion ?)."));
      document.head.appendChild(s);
    });
  }

  // Repère les colonnes « Nom » et « Pseudo » ; sans en-tête : A = nom, B = pseudo.
  function rowsFromSheet(matrix) {
    const clean = v => String(v == null ? "" : v).trim();
    const lines = matrix.map(r => (r || []).map(clean)).filter(r => r.some(Boolean));
    if (!lines.length) return [];
    const norm = v => v.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const head = lines[0].map(norm);
    let iPseudo = head.findIndex(h => /pseudo|surnom/.test(h));
    let iNom = head.findIndex(h => /^nom|nom complet|prenom|joueur|name/.test(h));
    let body = lines;
    if (iPseudo >= 0) body = lines.slice(1);
    else { iNom = 0; iPseudo = 1; }
    return body.map(r => ({ nom: iNom >= 0 ? (r[iNom] || "") : "", pseudo: r[iPseudo] || "" }))
      .filter(r => r.nom || r.pseudo);
  }

  $("import-btn").onclick = () => { $("import-input").value = ""; $("import-input").click(); };
  $("import-input").onchange = async () => {
    const file = $("import-input").files[0];
    if (!file) return;
    try {
      const XLSX = await loadSheetJs();
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      importRows = rowsFromSheet(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }));
      const taken = new Set(data.players.map(p => p.pseudo.toLowerCase()));
      $("import-preview").innerHTML = `
        <div class="card info">
          <h3>${icon("upload")} ${importRows.length} ligne(s) lue(s) dans « ${esc(file.name)} »</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Nom</th><th>Pseudo</th><th>État</th></tr></thead>
            <tbody>${importRows.map(r => `<tr><td>${esc(r.nom || "—")}</td><td>${esc(r.pseudo || "—")}</td><td>${
              !r.pseudo ? `<span class="badge red">${icon("alert")} pseudo vide</span>` :
              taken.has(r.pseudo.toLowerCase()) ? `<span class="badge plain">${icon("alert")} déjà pris</span>` :
              r.pseudo.length > 30 ? `<span class="badge plain">${icon("alert")} coupé à 30 caractères</span>` :
              `<span class="badge green">${icon("check")} à créer</span>`}</td></tr>`).join("")}</tbody>
          </table></div>
          <p></p>
          <div class="row">
            <button class="primary" id="import-go">Créer les joueurs</button>
            <button id="import-cancel">Annuler</button>
          </div>
        </div>`;
      $("import-cancel").onclick = () => { importRows = null; $("import-preview").innerHTML = ""; };
      $("import-go").onclick = doImport;
    } catch (e) { toast(e.message || "Fichier illisible.", "red"); }
  };

  async function doImport() {
    if (!importRows || !importRows.length) return;
    $("import-go").disabled = true;
    try {
      const r = await rpc("org_import_players", { p_rows: importRows });
      importRows = null;
      $("import-preview").innerHTML = `
        <div class="card ok">
          <h3>${icon("check")} ${r.created.length} joueur(s) créé(s)${r.skipped.length ? `, ${r.skipped.length} ignoré(s)` : ""}</h3>
          ${r.skipped.length ? `<p class="small">Ignorés : ${r.skipped.map(s => `${esc(s.pseudo || s.nom || "ligne vide")} (${esc(s.motif)})`).join(", ")}</p>` : ""}
          <p class="small">Télécharge les codes d'accès pour les remettre à chaque joueur.</p>
          <div class="row"><button class="primary" id="import-codes">Télécharger les codes (CSV)</button>
          <button id="import-close">Fermer</button></div>
        </div>`;
      $("import-codes").onclick = () => downloadCsv("wanted-codes-acces.csv",
        [["Nom", "Pseudo", "Code d'accès"]].concat(r.created.map(c => [c.nom || "", c.pseudo, c.access_code])));
      $("import-close").onclick = () => { $("import-preview").innerHTML = ""; };
      await refresh();
    } catch (e) { toast(e.message, "red"); $("import-go").disabled = false; }
  }

  $("export-codes").onclick = () => downloadCsv("wanted-codes-acces.csv",
    [["Nom", "Pseudo", "Code d'accès", "Actif"]].concat(data.players.map(p => [p.full_name || "", p.pseudo, p.access_code, p.active ? "oui" : "non"])));

  function downloadCsv(name, rows) {
    const cell = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const blob = new Blob(["﻿" + rows.map(r => r.map(cell).join(";")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }

  async function purge() {
    if (!confirm("Purger les données ? Toutes les photos, positions, abonnements aux notifications et messages du chat seront supprimés définitivement. Les scores sont conservés.")) return;
    if (!confirm("Confirmer la suppression définitive ?")) return;
    try {
      const paths = await rpc("org_purge");
      const listed = await sb.storage.from("photos").list("", { limit: 1000 });
      const all = new Set([...(paths || []), ...((listed.data || []).map(o => o.name))]);
      if (all.size) {
        const rm = await sb.storage.from("photos").remove([...all]);
        if (rm.error) throw rm.error;
      }
      toast(`Purge terminée : ${all.size} photo(s), positions et chat supprimés.`, "ok");
      await refresh();
    } catch (e) { toast(e.message, "red"); }
  }

  // ---------- Classement ----------

  let board = [];
  async function loadScoreboard() {
    try {
      board = await rpc("org_get_scoreboard");
      const sign = v => (v > 0 ? "+" : "") + v;
      let rank = 0, prev = null;
      $("scoreboard").innerHTML = board.map((r, i) => {
        if (r.total !== prev) { rank = i + 1; prev = r.total; }
        return `<tr style="${r.active ? "" : "opacity:.5"}">
          <td><b>${rank}</b></td><td><b>${esc(r.pseudo)}</b></td><td>${esc(r.full_name || "—")}</td>
          <td><span class="badge gold">${icon("star")} ${esc(r.total)}</span></td>
          <td>${esc(r.round1)}</td><td>${esc(r.round2)}</td><td>${esc(r.captures)}</td><td>${esc(r.captured)}</td>
          <td>${esc(r.missed_pings)}</td><td>${esc(sign(r.bonus))}</td><td>${esc(sign(r.quests))}</td><td>${esc(sign(r.corrections))}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="12" class="muted">Aucun joueur.</td></tr>`;
    } catch (e) { toast(e.message, "red"); }
  }

  $("export-csv").onclick = async () => {
    await loadScoreboard();
    downloadCsv("wanted-classement.csv",
      [["Rang", "Pseudo", "Nom", "Total", "Manche 1", "Manche 2", "Captures", "Capturé", "Pings manqués", "Bonus survivant", "Quêtes", "Corrections"]]
        .concat(board.map((r, i) => [i + 1, r.pseudo, r.full_name || "", r.total, r.round1, r.round2, r.captures, r.captured, r.missed_pings, r.bonus, r.quests, r.corrections])));
  };

  // ---------- Quêtes ----------

  let questData = { quests: [], claims: [] };
  const CLAIM_LABELS = { en_attente: "à traiter", validee: "validée", refusee: "refusée" };

  async function loadQuests() {
    try {
      questData = await rpc("org_get_quests");
      const pending = questData.claims.filter(c => c.status === "en_attente");
      $("claims-count").textContent = `(${pending.length} à traiter)`;
      $("claims").innerHTML = questData.claims.map(c => `
        <div class="claim ${c.status}">
          <div class="row">
            <div class="grow"><b>${esc(c.pseudo)}</b> · ${esc(c.title)} <span class="badge gold">${esc((c.points > 0 ? "+" : "") + c.points)} pt</span>
              <span class="badge ${c.status === "validee" ? "green" : c.status === "refusee" ? "plain" : "blue"}">${esc(CLAIM_LABELS[c.status])}</span>
              <div class="small muted">${esc(fmtTime(c.created_at))}${c.note ? ` · « ${esc(c.note)} »` : ""}</div></div>
            ${c.status !== "validee" ? `<button class="small green" data-claim="${c.id}" data-ok="1">${icon("check")} Valider</button>` : ""}
            ${c.status !== "refusee" ? `<button class="small danger" data-claim="${c.id}" data-ok="0">Refuser</button>` : ""}
          </div>
        </div>`).join("") || `<p class="muted">Aucune déclaration pour l'instant.</p>`;
      $("quests").innerHTML = questData.quests.map(q => `
        <div class="quest-row" style="${q.active ? "" : "opacity:.6"}">
          <div class="row">
            <div class="grow"><b>${esc(q.title)}</b> <span class="badge gold">${esc((q.points > 0 ? "+" : "") + q.points)} pt</span>
              <span class="small muted">· ${q.for_player ? "pour " + esc(q.for_player) : "tout le monde"} · ${q.round ? "manche " + q.round : "toutes manches"} · ${esc(q.done)} validée(s)${q.active ? "" : " · masquée"}</span>
              ${q.description ? `<div class="small">${esc(q.description)}</div>` : ""}</div>
            <button class="small" data-q="edit" data-id="${q.id}">Modifier</button>
            <button class="small" data-q="toggle" data-id="${q.id}">${q.active ? "Masquer" : "Afficher"}</button>
            <button class="small danger" data-q="delete" data-id="${q.id}">Suppr.</button>
          </div>
        </div>`).join("") || `<p class="muted">Aucune quête. Crée la première ci-dessus.</p>`;
    } catch (e) { toast(e.message, "red"); }
  }

  function resetQuestForm() {
    $("q-id").value = ""; $("q-title").value = ""; $("q-desc").value = ""; $("q-points").value = "1";
    $("q-player").value = ""; $("q-round").value = ""; $("q-active").checked = true;
    $("quest-form-title").textContent = "Nouvelle quête";
    $("q-save").textContent = "Créer la quête";
    $("q-cancel").classList.add("hidden");
  }

  $("q-save").onclick = async () => {
    const title = $("q-title").value.trim();
    if (!title) return toast("Donne un titre à la quête.", "red");
    try {
      await rpc("org_save_quest", {
        p_id: $("q-id").value ? Number($("q-id").value) : null,
        p_title: title, p_description: $("q-desc").value.trim(),
        p_points: parseInt($("q-points").value, 10) || 0,
        p_player: $("q-player").value || null,
        p_round: $("q-round").value ? Number($("q-round").value) : null,
        p_active: $("q-active").checked
      });
      toast($("q-id").value ? "Quête modifiée." : "Quête créée.", "ok");
      resetQuestForm();
      await loadQuests();
    } catch (e) { toast(e.message, "red"); }
  };
  $("q-cancel").onclick = resetQuestForm;

  $("quests").onclick = async e => {
    const b = e.target.closest("button[data-q]");
    if (!b) return;
    const q = questData.quests.find(x => x.id === Number(b.dataset.id));
    if (!q) return;
    if (b.dataset.q === "edit") {
      $("q-id").value = q.id; $("q-title").value = q.title; $("q-desc").value = q.description || "";
      $("q-points").value = q.points; $("q-player").value = q.player_id || ""; $("q-round").value = q.round || "";
      $("q-active").checked = q.active;
      $("quest-form-title").textContent = "Modifier la quête";
      $("q-save").textContent = "Enregistrer";
      $("q-cancel").classList.remove("hidden");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    try {
      if (b.dataset.q === "toggle") {
        await rpc("org_save_quest", { p_id: q.id, p_title: q.title, p_description: q.description, p_points: q.points,
          p_player: q.player_id, p_round: q.round, p_active: !q.active });
        await loadQuests();
      }
      if (b.dataset.q === "delete") {
        if (!confirm(`Supprimer la quête « ${q.title} » ? Les points déjà donnés pour elle seront retirés.`)) return;
        await rpc("org_delete_quest", { p_id: q.id });
        await loadQuests();
      }
    } catch (err) { toast(err.message, "red"); }
  };

  $("claims").onclick = async e => {
    const b = e.target.closest("button[data-claim]");
    if (!b) return;
    try {
      await rpc("org_decide_claim", { p_claim: Number(b.dataset.claim), p_accept: b.dataset.ok === "1" });
      await loadQuests();
      await refresh();
    } catch (err) { toast(err.message, "red"); }
  };

  // ---------- Chat ----------

  const chat = WC.mount($("org-chat"), $("org-chat-body"), $("org-chat-send"), { isOrg: true });
  function renderChatState(enabled) {
    $("chat-state").innerHTML = enabled
      ? `<span class="badge green">${icon("check")} ouvert</span>`
      : `<span class="badge plain">${icon("lock")} fermé aux joueurs</span>`;
    $("chat-toggle").textContent = enabled ? "Fermer le chat" : "Ouvrir le chat";
  }
  $("chat-toggle").onclick = () => act("org_set_chat", { p_enabled: !data.chat_enabled },
    data.chat_enabled ? "Fermer le chat ? Les joueurs ne pourront plus écrire (ils verront toujours les anciens messages)." : null);

  // ---------- Messages, captures ----------

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

  // ---------- Synchronisation ----------

  async function refresh() {
    try {
      await ensureSession();
      data = await rpc("org_get_overview");
      syncClock(data.server_now);
      render();
      loadTab();
    } catch (e) {
      if (/organisateur/i.test(e.message)) {
        $("dash").classList.add("hidden");
        $("logout").classList.add("hidden");
        $("login").classList.remove("hidden");
      } else {
        toast(e.message, "red");
      }
    }
  }

  try { const t = localStorage.getItem("wanted-org-tab"); if (t && document.querySelector(`[data-panel="${t}"]`)) tab = t; } catch (e) { /* ignoré */ }
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== tab));

  setInterval(refresh, 5000);
  setInterval(tick, 1000);
  refresh();
})();
