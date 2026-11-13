// Chat général, partagé par l'écran joueur et l'écran organisateur.
(function () {
  const { rpc, esc, fmtTime, toast } = window.W;

  // mount(listEl, inputEl, sendBtn, opts) → { load(), lastId, enabled }
  // opts.isOrg : affiche les messages masqués et le bouton « Masquer ».
  function mount(listEl, inputEl, sendBtn, opts) {
    opts = opts || {};
    const st = { lastId: 0, enabled: true, loading: false, msgs: new Map() };

    function draw() {
      const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
      const arr = [...st.msgs.values()].sort((a, b) => a.id - b.id).slice(-200);
      listEl.innerHTML = arr.map(m => `
        <div class="msg${m.mine ? " mine" : ""}${m.is_org ? " org" : ""}${m.deleted ? " deleted" : ""}" data-id="${m.id}">
          <div class="meta"><b>${esc(m.author || "?")}</b> · ${esc(fmtTime(m.created_at))}${m.deleted ? " · masqué" : ""}
            ${opts.isOrg && !m.deleted ? `<button class="small link" data-hide="${m.id}">Masquer</button>` : ""}</div>
          <div class="body">${esc(m.body)}</div>
        </div>`).join("") || `<p class="muted center">Aucun message pour l'instant.</p>`;
      if (atBottom || st.firstDraw !== false) { listEl.scrollTop = listEl.scrollHeight; st.firstDraw = false; }
      if (opts.onState) opts.onState(st);
    }

    async function load(full) {
      if (st.loading) return;
      st.loading = true;
      try {
        const r = await rpc("get_chat", { p_after: full ? 0 : st.lastId });
        st.enabled = r.enabled;
        if (full) st.msgs.clear();
        (r.messages || []).forEach(m => { st.msgs.set(m.id, m); st.lastId = Math.max(st.lastId, m.id); });
        if (full || (r.messages || []).length) draw();
        else if (opts.onState) opts.onState(st);
      } catch (e) { /* réessai au prochain tour */ }
      finally { st.loading = false; }
    }

    async function send() {
      const body = inputEl.value.trim();
      if (!body) return;
      sendBtn.disabled = true;
      try {
        await rpc("send_chat", { p_body: body });
        inputEl.value = "";
        await load(false);
      } catch (e) { toast(e.message, "red"); }
      finally { sendBtn.disabled = false; inputEl.focus(); }
    }

    sendBtn.onclick = send;
    inputEl.onkeydown = e => { if (e.key === "Enter") send(); };
    listEl.onclick = async e => {
      const b = e.target.closest("button[data-hide]");
      if (!b || !confirm("Masquer ce message pour les joueurs ?")) return;
      try { await rpc("org_delete_chat", { p_id: Number(b.dataset.hide) }); await load(true); }
      catch (err) { toast(err.message, "red"); }
    };

    return { load, st };
  }

  // Dernier message lu, mémorisé sur ce téléphone pour le badge « non lus ».
  function getSeen(key) { try { return Number(localStorage.getItem(key) || 0); } catch (e) { return 0; } }
  function setSeen(key, id) { try { localStorage.setItem(key, String(id || 0)); } catch (e) { /* ignoré */ } }

  window.WC = { mount, getSeen, setSeen };
})();
