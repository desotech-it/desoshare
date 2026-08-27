// Core dell'editor di note collaborativo (riusato da app.js e dalla pagina pubblica share.php).
// Espone window.NoteEditor.{loadBundle, mount}. La logica CRDT/Yjs vive nel bundle window.DesoEditor.
(function () {
  const b64ToU8 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  const u8ToB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  function userColor(n) { let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return 'hsl(' + (h % 360) + ',65%,45%)'; }
  function genClientId() { const a = new Uint8Array(8); (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = i)); return 'c' + Array.from(a, b => ('0' + b.toString(16)).slice(-2)).join(''); }

  function loadBundle(url) {
    if (window.DesoEditor) return Promise.resolve(window.DesoEditor);
    if (window.__edLoad) return window.__edLoad;
    window.__edLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      // In caso di errore la cache va AZZERATA (e lo <script> rimosso): altrimenti
      // la promise rifiutata resterebbe memorizzata e ogni apertura successiva
      // ripiegherebbe sull'editor semplice anche a rete ripristinata.
      s.onload = () => {
        if (window.DesoEditor) resolve(window.DesoEditor);
        else { window.__edLoad = null; s.remove(); reject(new Error('bundle non valido')); }
      };
      s.onerror = () => { window.__edLoad = null; s.remove(); reject(new Error('caricamento editor fallito')); };
      document.head.appendChild(s);
    });
    return window.__edLoad;
  }

  // opts: { host, statusEl?, presEl?, info, sync(payload)->Promise,
  //         save(content, snapshot)->Promise, reopen()->Promise<info> }
  // Ritorna una funzione di cleanup. Richiede window.DesoEditor già caricato.
  //
  // PROTOCOLLO A GENERAZIONI: il server assegna al relay un id di epoca ('gen').
  // Un salvataggio COMPATTA il relay allo snapshot Yjs completo e cambia gen: i
  // client connessi rilevano il cambio in modo deterministico, ripartono da
  // offset 0 sullo STESSO doc (lo snapshot è idempotente, cursore preservato) e
  // chi apre dopo riceve lo stato completo. Solo un salvataggio SENZA snapshot
  // (editor semplice) o il GC del relay richiedono la ricostruzione dal file
  // (resync → reopen).
  function mount(opts) {
    const E = window.DesoEditor;
    const { host, statusEl, presEl, info, sync, save, reopen } = opts;
    const { Y, EditorState, EditorView, basicExtensions, yCollab, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } = E;
    const clientId = genClientId();
    const editable = !!info.editable;
    let cur = null;                       // { doc, ytext, awareness, ev } correnti
    let offset = 0, gen = '';
    let pending = [];
    let stopped = false, saveTimer = null, dirty = false, resyncing = false;

    const saveNow = async () => {
      if (!dirty || !editable || !cur) return;
      dirty = false;
      let r = null;
      // Lo snapshot (stato Yjs completo) permette al server di compattare il relay
      // preservando la lineage del documento per tutti i client.
      try { r = await save(cur.ytext.toString(), u8ToB64(Y.encodeStateAsUpdate(cur.doc))); } catch (_) { r = null; }
      if (r && r.ok) {
        if (r.gen) { gen = r.gen; offset = typeof r.offset === 'number' ? r.offset : 0; }
        if (statusEl) statusEl.textContent = 'connesso';
      } else {
        // 507 quota, 500, rete: l'errore va MOSTRATO e il contenuto resta dirty,
        // con un nuovo tentativo programmato — non «salvato» in silenzio.
        dirty = true;
        if (statusEl) statusEl.textContent = 'errore salvataggio: ' + ((r && r.error) || 'rete');
        if (!stopped) { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 5000); }
      }
    };

    // (Ri)costruisce doc+editor da uno stato note_open: all'avvio e nel raro
    // resync completo (salvataggio dall'editor semplice, o GC del relay).
    const initDoc = (st) => {
      if (cur) { try { cur.ev.destroy(); } catch (_) {} try { cur.doc.destroy(); } catch (_) {} }
      pending = []; dirty = false; clearTimeout(saveTimer);
      const doc = new Y.Doc();
      const ytext = doc.getText('content');
      const awareness = new Awareness(doc);
      awareness.setLocalStateField('user', { name: st.user || 'utente', color: userColor(st.user || '') });
      // Osservatore PRIMA del seed: l'eventuale seed (idempotente) viene così inviato al relay.
      doc.on('update', (u, origin) => { if (origin !== 'remote') pending.push(u8ToB64(u)); });
      // Stato dal relay = sorgente di verità durante la collaborazione.
      (st.updates || []).forEach(u => Y.applyUpdate(doc, b64ToU8(u), 'remote'));
      offset = st.offset || 0;
      gen = st.gen || '';
      // Seed SOLO se il relay è vuoto. clientID FISSO → item identici su ogni client (seed idempotente),
      // così le modifiche di chiunque si ancorano allo stesso testo iniziale e si integrano ovunque.
      if (ytext.length === 0 && offset === 0 && st.text) {
        const t = new TextDecoder().decode(b64ToU8(st.text));
        if (t.length) { const orig = doc.clientID; doc.clientID = 1; ytext.insert(0, t); doc.clientID = orig; }
      }
      host.innerHTML = '';
      const ev = new EditorView({
        state: EditorState.create({ doc: ytext.toString(), extensions: [...basicExtensions(editable), yCollab(ytext, awareness)] }),
        parent: host,
      });
      // Solo le modifiche LOCALI marcano dirty: gli update arrivati dal relay
      // (origin 'remote') non devono far salvare ogni client che ha la nota aperta.
      ytext.observe((evn, tr) => { if (editable && tr.origin !== 'remote') { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 2000); } });
      cur = { doc, ytext, awareness, ev };
    };

    const renderPresence = () => {
      if (!presEl || !cur) return;
      const names = new Set();
      cur.awareness.getStates().forEach((s, cid) => { if (cid !== cur.awareness.clientID && s.user) names.add(s.user.name); });
      presEl.textContent = names.size ? ('Collegati: ' + [...names].join(', ')) : 'Nessun altro collegato';
    };
    const resyncFull = async () => {
      if (resyncing || !reopen) return;
      resyncing = true;
      try { const ni = await reopen(); if (ni && ni.ok && !stopped) { initDoc(ni); renderPresence(); } } catch (_) {}
      resyncing = false;
    };
    const tick = async () => {
      if (stopped || resyncing) return;
      const send = pending.splice(0);
      const awB64 = u8ToB64(encodeAwarenessUpdate(cur.awareness, [cur.awareness.clientID]));
      let r;
      try { r = await sync({ id: info.id, since: offset, client: clientId, gen, updates: send, aware: awB64 }); }
      catch (_) { if (send.length) pending.unshift.apply(pending, send); return; }
      if (!(r && r.ok)) { if (send.length) pending.unshift.apply(pending, send); return; }
      if (r.resync) {
        // Epoca cambiata e relay vuoto: l'unica fonte è il file, ricostruzione completa.
        if (send.length) pending.unshift.apply(pending, send);
        await resyncFull();
        return;
      }
      if (r.gen && r.gen !== gen) {
        // Epoca nuova con snapshot: il server ha risposto dall'inizio e NON ha
        // accodato i nostri update → si ri-inviano al prossimo tick sotto la nuova
        // epoca. Il doc locale continua (stessa lineage): nessuna ricostruzione.
        gen = r.gen;
        if (send.length) pending.unshift.apply(pending, send);
      } else if (r.relay_full && send.length) {
        // Relay pieno: gli update NON sono stati accodati. Si trattengono e si
        // forza un salvataggio, che compatta il relay allo snapshot (nuova epoca).
        pending.unshift.apply(pending, send);
        if (editable) { dirty = true; clearTimeout(saveTimer); await saveNow(); }
      }
      (r.updates || []).forEach(u => Y.applyUpdate(cur.doc, b64ToU8(u), 'remote'));
      offset = r.offset;
      (r.aware || []).forEach(a => { try { applyAwarenessUpdate(cur.awareness, b64ToU8(a.b64), 'remote'); } catch (_) {} });
      renderPresence();
    };

    initDoc(info);
    if (statusEl) statusEl.textContent = editable ? 'connesso' : 'sola lettura';
    const iv = setInterval(tick, info.poll_ms || 1500);
    tick();
    return () => {
      stopped = true; clearInterval(iv); clearTimeout(saveTimer);
      saveNow();
      try { removeAwarenessStates(cur.awareness, [cur.awareness.clientID], 'local'); } catch (_) {}
      try { cur.ev.destroy(); } catch (_) {}
      try { cur.doc.destroy(); } catch (_) {}
    };
  }

  window.NoteEditor = { loadBundle, mount, b64ToU8 };
})();
