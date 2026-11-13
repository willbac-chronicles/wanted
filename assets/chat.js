// Chat partagé par l'écran joueur et l'écran organisateur :
// conversation générale, messages privés, messages vocaux.
(function () {
  const { sb, rpc, esc, fmtTime, toast, icon, randomName } = window.W;

  const MAX_SECONDS = 60;
  const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"];
  const EXT = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/x-m4a": "m4a" };

  // Liens signés des fichiers du bucket « media », mis en cache 50 min.
  const mediaCache = new Map();
  async function mediaUrl(path) {
    const hit = mediaCache.get(path);
    if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await sb.storage.from("media").createSignedUrl(path, 3600);
    if (error) throw new Error("Fichier indisponible");
    mediaCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    return data.signedUrl;
  }

  async function myUid() {
    const { data } = await sb.auth.getSession();
    const uid = data && data.session && data.session.user && data.session.user.id;
    if (!uid) throw new Error("Session expirée : recharge la page");
    return uid;
  }

  // Dépose un fichier dans media/<dossier>/<auth uid>/... et renvoie son chemin.
  async function uploadMedia(folder, blob, ext, contentType) {
    const path = `${folder}/${await myUid()}/${randomName(ext)}`;
    const up = await sb.storage.from("media").upload(path, blob, { contentType, upsert: false });
    if (up.error) throw new Error("Envoi du fichier impossible : " + up.error.message);
    return path;
  }

  const fmtSec = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // mount(els, opts) → { load(full), st, setConv(key) }
  // els : { list, input, send, mic, conv (select), hint }
  // opts.isOrg : messages masqués visibles, bouton « Masquer », destinataires = tous les joueurs.
  function mount(els, opts) {
    opts = opts || {};
    const st = { conv: "all", lastId: 0, enabled: true, dmEnabled: true, contacts: [], unread: [], loading: false, msgs: new Map(), firstDraw: true };

    // ----- Affichage -----

    function convName(key) {
      if (key === "all") return "Tout le monde";
      const c = st.contacts.find(x => x.key === key);
      return c ? c.name : "Conversation";
    }

    function drawSelect() {
      if (!els.conv) return;
      const keys = ["all"].concat(st.contacts.map(c => c.key));
      if (!keys.includes(st.conv)) keys.push(st.conv);
      const html = keys.map(k => {
        const dot = k !== st.conv && st.unread.includes(k) ? "• " : "";
        const label = k === "all" ? "Tout le monde (général)" : (k === "org" ? "Organisation (privé)" : convName(k) + " (privé)");
        return `<option value="${esc(k)}"${k === st.conv ? " selected" : ""}>${esc(dot + label)}</option>`;
      }).join("");
      if (els.conv.dataset.html !== html) { els.conv.innerHTML = html; els.conv.dataset.html = html; }
    }

    function drawHint() {
      const closed = !opts.isOrg && st.conv === "all" && !st.enabled;
      els.input.disabled = closed; els.send.disabled = closed;
      if (els.mic) els.mic.disabled = closed;
      els.input.placeholder = st.conv === "all" ? "Écrire à tout le monde…" : `Écrire à ${convName(st.conv)}…`;
      if (!els.hint) return;
      let t;
      if (closed) t = "Le chat général est fermé par l'organisation pour le moment. Les messages privés restent possibles.";
      else if (st.conv === "all") t = opts.isOrg
        ? "Visible de tous les joueurs. Tes messages sont signés « Organisation »."
        : "Visible de tous les joueurs et de l'organisation. Ne donne pas ta position ni ton code !";
      else if (opts.isOrg) t = `Conversation privée avec ${convName(st.conv)}, qui reçoit une notification à chaque message.`;
      else if (st.conv === "org") t = "Conversation privée avec l'organisation.";
      else t = `Conversation privée avec ${convName(st.conv)} : l'organisation ne la lit pas. Reste correct.`;
      if (!opts.isOrg && !st.dmEnabled) t += " Les messages privés entre joueurs sont fermés.";
      els.hint.textContent = t;
    }

    function msgHtml(m) {
      const voice = m.media_path
        ? `<div class="voice" data-media="${esc(m.media_path)}"><button class="small blue" data-play="1">${icon("play")} Écouter${m.media_seconds ? " (" + fmtSec(m.media_seconds) + ")" : ""}</button></div>`
        : "";
      return `
        <div class="msg${m.mine ? " mine" : ""}${m.is_org ? " org" : ""}${m.deleted ? " deleted" : ""}" data-id="${m.id}">
          <div class="meta"><b>${esc(m.author || "?")}</b> · ${esc(fmtTime(m.created_at))}${m.deleted ? " · masqué" : ""}
            ${opts.isOrg && !m.deleted ? `<button class="small link" data-hide="${m.id}">Masquer</button>` : ""}</div>
          ${m.body ? `<div class="body">${esc(m.body)}</div>` : ""}${voice}
        </div>`;
    }

    function draw() {
      const atBottom = els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 60;
      const arr = [...st.msgs.values()].sort((a, b) => a.id - b.id).slice(-200);
      // Les lecteurs déjà ouverts sont conservés pour ne pas couper un message en cours d'écoute.
      const players = new Map();
      els.list.querySelectorAll(".voice[data-media]").forEach(v => { if (v.querySelector("audio")) players.set(v.dataset.media, v.firstElementChild); });
      els.list.innerHTML = arr.map(msgHtml).join("") || `<p class="muted center">Aucun message pour l'instant.</p>`;
      players.forEach((node, path) => {
        const v = els.list.querySelector(`.voice[data-media="${CSS.escape(path)}"]`);
        if (v) v.replaceChildren(node);
      });
      if (atBottom || st.firstDraw) { els.list.scrollTop = els.list.scrollHeight; st.firstDraw = false; }
    }

    function applyMeta(r) {
      st.enabled = r.enabled !== false;
      st.dmEnabled = r.dm_enabled !== false;
      st.unread = r.unread || [];
      if (r.contacts) st.contacts = r.contacts;
      drawSelect();
      drawHint();
      if (opts.onState) opts.onState(st);
    }

    async function load(full) {
      if (st.loading) return;
      st.loading = true;
      const conv = st.conv;
      try {
        const r = await rpc("get_chat", { p_after: full ? 0 : st.lastId, p_conv: conv });
        if (conv !== st.conv) return; // conversation changée entre-temps
        if (full) st.msgs.clear();
        (r.messages || []).forEach(m => { st.msgs.set(m.id, m); st.lastId = Math.max(st.lastId, m.id); });
        if (full || (r.messages || []).length) draw();
        applyMeta(r);
      } catch (e) { /* réessai au prochain tour */ }
      finally { st.loading = false; }
    }

    function setConv(key) {
      if (rec) stopRec(false);
      st.conv = key || "all";
      st.lastId = 0; st.msgs.clear(); st.firstDraw = true;
      els.list.innerHTML = `<p class="muted center">Chargement…</p>`;
      drawSelect(); drawHint();
      st.loading = false;
      return load(true);
    }

    // ----- Envoi texte -----

    async function send() {
      const body = els.input.value.trim();
      if (!body) return;
      els.send.disabled = true;
      try {
        await rpc("send_chat", { p_body: body, p_to: st.conv });
        els.input.value = "";
        await load(false);
      } catch (e) { toast(e.message, "red"); }
      finally { drawHint(); if (!els.input.disabled) els.input.focus(); }
    }
    els.send.onclick = send;
    els.input.onkeydown = e => { if (e.key === "Enter") send(); };
    if (els.conv) els.conv.onchange = () => setConv(els.conv.value);

    // ----- Messages vocaux -----

    let rec = null;
    const bar = document.createElement("div");
    bar.className = "rec-bar hidden";
    bar.innerHTML = `<span class="rec-dot" aria-hidden="true"></span><span class="grow">Enregistrement <b class="rec-time">0:00</b> / ${fmtSec(MAX_SECONDS)}</span>
      <button class="small" data-rec="cancel">Annuler</button>
      <button class="small primary" data-rec="send">${icon("send")} Envoyer</button>`;
    els.input.parentElement.after(bar);
    bar.onclick = e => { const b = e.target.closest("button[data-rec]"); if (b) stopRec(b.dataset.rec === "send"); };

    function showBar(on) {
      bar.classList.toggle("hidden", !on);
      els.input.parentElement.classList.toggle("hidden", on);
    }

    async function startRec() {
      if (rec) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        return toast("Ce navigateur ne permet pas d'enregistrer un message vocal.", "red");
      }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e) { return toast("Micro refusé : autorise-le pour ce site dans les réglages du téléphone.", "red"); }
      const type = AUDIO_TYPES.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
      let mr;
      try { mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
      catch (e) { stream.getTracks().forEach(t => t.stop()); return toast("Enregistrement impossible sur ce téléphone.", "red"); }
      const cur = { mr, stream, chunks: [], started: Date.now(), conv: st.conv };
      rec = cur;
      // Le dernier morceau arrive après stop() : on l'ajoute à cet enregistrement-ci.
      mr.ondataavailable = e => { if (e.data && e.data.size) cur.chunks.push(e.data); };
      mr.start(1000);
      const timeEl = bar.querySelector(".rec-time");
      timeEl.textContent = "0:00";
      rec.timer = setInterval(() => {
        const s = Math.floor((Date.now() - rec.started) / 1000);
        timeEl.textContent = fmtSec(Math.min(s, MAX_SECONDS));
        if (s >= MAX_SECONDS) stopRec(true);
      }, 250);
      showBar(true);
    }

    async function stopRec(doSend) {
      const r = rec;
      if (!r) return;
      rec = null;
      clearInterval(r.timer);
      showBar(false);
      await new Promise(resolve => {
        if (r.mr.state === "inactive") return resolve();
        r.mr.onstop = () => resolve();
        try { r.mr.stop(); } catch (e) { resolve(); }
      });
      r.stream.getTracks().forEach(t => t.stop());
      if (!doSend) return;
      const secs = Math.round((Date.now() - r.started) / 1000);
      if (secs < 1 || !r.chunks.length) return toast("Message trop court.", "red");
      const base = (r.mr.mimeType || (r.chunks[0] && r.chunks[0].type) || "audio/webm").split(";")[0];
      const blob = new Blob(r.chunks, { type: base });
      if (els.mic) els.mic.disabled = true;
      toast("Envoi du message vocal…");
      try {
        const path = await uploadMedia("chat", blob, EXT[base] || "webm", base);
        await rpc("send_chat", { p_body: "", p_to: r.conv, p_media: path, p_seconds: Math.min(secs, MAX_SECONDS) });
        toast("Message vocal envoyé.", "ok");
        if (r.conv === st.conv) await load(false);
      } catch (e) { toast(e.message, "red"); }
      finally { drawHint(); }
    }
    if (els.mic) {
      els.mic.innerHTML = icon("mic");
      els.mic.setAttribute("aria-label", "Enregistrer un message vocal");
      els.mic.title = "Message vocal";
      els.mic.onclick = startRec;
    }

    // ----- Clics dans la liste : écouter, masquer -----

    els.list.onclick = async e => {
      const play = e.target.closest("button[data-play]");
      if (play) {
        const box = play.closest(".voice");
        play.disabled = true;
        try {
          const url = await mediaUrl(box.dataset.media);
          const audio = document.createElement("audio");
          audio.controls = true; audio.preload = "auto"; audio.src = url;
          box.replaceChildren(audio);
          audio.play().catch(() => { /* lecture manuelle avec les commandes */ });
        } catch (err) { toast(err.message, "red"); play.disabled = false; }
        return;
      }
      const b = e.target.closest("button[data-hide]");
      if (!b || !confirm("Masquer ce message pour les joueurs ?")) return;
      try { await rpc("org_delete_chat", { p_id: Number(b.dataset.hide) }); await load(true); }
      catch (err) { toast(err.message, "red"); }
    };

    drawSelect(); drawHint();
    return { load, st, setConv };
  }

  window.WC = { mount, mediaUrl, uploadMedia };
})();
