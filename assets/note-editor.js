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
      s.onload = () => window.DesoEditor ? resolve(window.DesoEditor) : reject(new Error('bundle non valido'));
      s.onerror = () => reject(new Error('caricamento editor fallito'));
      document.head.appendChild(s);
    });
    return window.__edLoad;
  }

  // opts: { host, statusEl?, presEl?, info, sync(payload)->Promise, save(content)->Promise }
  // Ritorna una funzione di cleanup. Richiede window.DesoEditor già caricato.
  function mount(opts) {
    const E = window.DesoEditor;
    const { host, statusEl, presEl, info, sync, save } = opts;
    const { Y, EditorState, EditorView, basicExtensions, yCollab, Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } = E;
    const doc = new Y.Doc();
    const ytext = doc.getText('content');
    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', { name: info.user || 'utente', color: userColor(info.user || '') });
    const clientId = genClientId();

    // Osservatore PRIMA del seed: l'eventuale seed (idempotente) viene così inviato al relay.
    const pending = [];
    doc.on('update', (u, origin) => { if (origin !== 'remote') pending.push(u8ToB64(u)); });

    // Stato dal relay = sorgente di verità durante la collaborazione.
    (info.updates || []).forEach(u => Y.applyUpdate(doc, b64ToU8(u), 'remote'));
    let offset = info.offset || 0;
    // Seed SOLO se il relay è vuoto. clientID FISSO → item identici su ogni client (seed idempotente),
    // così le modifiche di chiunque si ancorano allo stesso testo iniziale e si integrano ovunque.
    if (ytext.length === 0 && offset === 0 && info.text) {
      const t = new TextDecoder().decode(b64ToU8(info.text));
      if (t.length) { const orig = doc.clientID; doc.clientID = 1; ytext.insert(0, t); doc.clientID = orig; }
    }
    host.innerHTML = '';
    const ev = new EditorView({
      state: EditorState.create({ doc: ytext.toString(), extensions: [...basicExtensions(info.editable), yCollab(ytext, awareness)] }),
      parent: host,
    });
    if (statusEl) statusEl.textContent = info.editable ? 'connesso' : 'sola lettura';
    let stopped = false, saveTimer = null, dirty = false;
    const saveNow = async () => { if (!dirty || !info.editable) return; dirty = false; try { await save(ytext.toString()); } catch (_) {} };
    ytext.observe(() => { if (info.editable) { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 2000); } });
    const renderPresence = () => {
      if (!presEl) return;
      const names = new Set();
      awareness.getStates().forEach((s, cid) => { if (cid !== awareness.clientID && s.user) names.add(s.user.name); });
      presEl.textContent = names.size ? ('Collegati: ' + [...names].join(', ')) : 'Nessun altro collegato';
    };
    const tick = async () => {
      if (stopped) return;
      const send = pending.splice(0);
      const awB64 = u8ToB64(encodeAwarenessUpdate(awareness, [awareness.clientID]));
      let r;
      try { r = await sync({ id: info.id, since: offset, client: clientId, updates: send, aware: awB64 }); }
      catch (_) { if (send.length) pending.unshift.apply(pending, send); return; }
      if (r && r.ok) {
        (r.updates || []).forEach(u => Y.applyUpdate(doc, b64ToU8(u), 'remote'));
        offset = r.offset;
        (r.aware || []).forEach(a => { try { applyAwarenessUpdate(awareness, b64ToU8(a.b64), 'remote'); } catch (_) {} });
        renderPresence();
      } else if (send.length) { pending.unshift.apply(pending, send); }
    };
    const iv = setInterval(tick, info.poll_ms || 1500);
    tick();
    return () => {
      stopped = true; clearInterval(iv); clearTimeout(saveTimer);
      saveNow();
      try { removeAwarenessStates(awareness, [awareness.clientID], 'local'); } catch (_) {}
      try { ev.destroy(); } catch (_) {}
      try { doc.destroy(); } catch (_) {}
    };
  }

  window.NoteEditor = { loadBundle, mount, b64ToU8 };
})();
