// Upload dalla pagina PUBBLICA di una cartella condivisa con link modificabile.
// Stesso protocollo a blocchi di app-src/upload.js (ripresa, blocchi paralleli,
// ritentativi), ma autenticato dal TOKEN della condivisione (parametro t) al
// posto di sessione+CSRF: lato server è upload_ctx() a confinare la scrittura
// alla cartella del link. Espone window.ShareUpload.mount({token,path,input,list}).
(function () {
  const CHUNK = 16 * 1024 * 1024;   // 16 MB per blocco (come l'app)
  const CONC = 3;                   // blocchi in parallelo per file
  const MAX_RETRY = 5;

  function fmtBytes(b) {
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(1) : b) + ' ' + u[i];
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  async function fileUid(dir, f) {
    const sig = [dir, f.name, f.size, f.lastModified].join('\n');
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    } catch (_) {
      let h = 0; for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) >>> 0;
      return ('0000000' + h.toString(16)).slice(-8).repeat(2);
    }
  }
  function endpoint(action, token) { return 'api.php?action=' + action + '&t=' + encodeURIComponent(token); }
  function post(action, token, fields) {
    const fd = new FormData();
    for (const k in fields) fd.append(k, fields[k]);
    return fetch(endpoint(action, token), { method: 'POST', body: fd }).then(r => r.json());
  }

  function sendChunk(token, uid, index, offset, chunkSize, total, blob, dir, name, onProg, attempt = 0) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint('upload_chunk', token));
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProg) onProg(e.loaded); };
      const retry = () => {
        if (attempt < MAX_RETRY) setTimeout(() => sendChunk(token, uid, index, offset, chunkSize, total, blob, dir, name, onProg, attempt + 1).then(resolve, reject), 800 * (attempt + 1));
        else reject(new Error('connessione interrotta'));
      };
      xhr.onload = () => {
        let r = {}; try { r = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status === 200 && r.ok) resolve(r);
        else if (xhr.status >= 500 || xhr.status === 0) retry();
        else reject(new Error(r.error || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = retry;
      const fd = new FormData();
      fd.append('uid', uid); fd.append('index', index); fd.append('offset', offset);
      fd.append('chunk_size', chunkSize); fd.append('total', total);
      fd.append('path', dir); fd.append('name', name);
      fd.append('chunk', blob);
      xhr.send(fd);
    });
  }

  async function uploadOne(token, dir, f, row) {
    const uid = await fileUid(dir, f);
    if (f.size === 0) {   // file vuoto: niente blocchi, si finalizza direttamente
      const fin = await post('upload_finish', token, { uid, path: dir, name: f.name, total: 0, chunk_size: CHUNK });
      if (!fin.ok) throw new Error(fin.error || 'finalizzazione fallita');
      row.prog(0, 0); return;
    }
    let chunkSize = CHUNK; const doneSet = new Set();
    try {   // ripresa: blocchi già ricevuti dal server per questo uid
      const st = await fetch(endpoint('upload_status', token) + '&uid=' + uid).then(x => x.json());
      if (st.ok) { if (st.chunk > 0) chunkSize = st.chunk; (st.parts || []).forEach(i => doneSet.add(i)); }
    } catch (_) {}
    const count = Math.max(1, Math.ceil(f.size / chunkSize));
    const lenOf = i => Math.min(chunkSize, f.size - i * chunkSize);
    let doneBytes = 0; doneSet.forEach(i => doneBytes += lenOf(i));
    const missing = []; for (let i = 0; i < count; i++) if (!doneSet.has(i)) missing.push(i);
    const live = new Map();
    const refresh = () => { let l = 0; live.forEach(v => l += v); row.prog(doneBytes + l, f.size); };
    refresh();
    let next = 0, failed = null;
    const worker = async () => {
      while (next < missing.length && !failed) {
        const idx = missing[next++];
        const offset = idx * chunkSize, end = Math.min(offset + chunkSize, f.size);
        try {
          await sendChunk(token, uid, idx, offset, chunkSize, f.size, f.slice(offset, end), dir, f.name, loaded => { live.set(idx, loaded); refresh(); });
          live.delete(idx); doneBytes += (end - offset); refresh();
        } catch (e) { failed = e; live.delete(idx); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, missing.length || 1) }, worker));
    if (failed) throw failed;
    const fin = await post('upload_finish', token, { uid, path: dir, name: f.name, total: f.size, chunk_size: chunkSize });
    if (!fin.ok) throw new Error(fin.error || 'finalizzazione fallita');
  }

  // Espande le cartelle trascinate (entry API) in una lista piatta {file, rel}.
  function walkEntry(entry, parentPath) {
    return new Promise(resolve => {
      if (entry.isFile) entry.file(f => resolve([{ file: f, rel: parentPath }]), () => resolve([]));
      else if (entry.isDirectory) {
        const dirPath = parentPath ? parentPath + '/' + entry.name : entry.name;
        const reader = entry.createReader(); const acc = [];
        const read = () => reader.readEntries(async ents => {
          if (!ents.length) { const nested = await Promise.all(acc.map(e => walkEntry(e, dirPath))); resolve(nested.flat()); return; }
          acc.push(...ents); read();
        }, () => resolve([]));
        read();
      } else resolve([]);
    });
  }

  function mount(o) {
    const input = document.querySelector(o.input), list = document.querySelector(o.list);
    if (!input || !list) return;
    let busy = false;
    function makeRow(label) {
      const el = document.createElement('div');
      el.className = 'up-row';
      el.innerHTML = '<div class="up-head"><span class="up-name" title="' + esc(label) + '">' + esc(label) + '</span><span class="up-stat">in attesa</span></div><div class="progress"><div></div></div>';
      list.appendChild(el);
      const bar = el.querySelector('.progress > div'), stat = el.querySelector('.up-stat');
      return {
        prog(done, total) { const pct = total ? Math.min(100, Math.round(done / total * 100)) : 100; bar.style.width = pct + '%'; stat.textContent = pct + '% · ' + fmtBytes(done) + ' / ' + fmtBytes(total); },
        ok() { stat.textContent = 'completato'; stat.style.color = 'var(--ok)'; },
        err(m) { stat.textContent = 'errore: ' + m; stat.style.color = 'var(--danger)'; },
      };
    }
    async function run(items) {
      if (!items.length) return;
      if (busy) { alert('Un caricamento è già in corso: attendi che finisca'); return; }
      busy = true; list.innerHTML = '';
      let errors = 0;
      // Destinazione = cartella della pagina (+ sottocartella trascinata). I file
      // vanno in sequenza; i blocchi di ciascuno in parallelo.
      for (const it of items) {
        const dir = [o.path || '', it.rel || ''].filter(Boolean).join('/');
        const row = makeRow((it.rel ? it.rel + '/' : '') + it.file.name);
        try { await uploadOne(o.token, dir, it.file, row); row.ok(); }
        catch (e) { errors++; row.err(e.message || e); }
      }
      busy = false; input.value = '';
      // Tutto bene: la pagina si ricarica e mostra i nuovi file. Con errori resta
      // il resoconto, e un pulsante per aggiornare l'elenco quando si vuole.
      if (!errors) { location.reload(); return; }
      const act = document.createElement('div');
      act.className = 'up-actions';
      act.innerHTML = '<button class="btn" type="button"><i class="ti ti-refresh"></i> Aggiorna elenco</button>';
      act.querySelector('button').onclick = () => location.reload();
      list.appendChild(act);
    }
    input.addEventListener('change', () => run([...input.files].map(f => ({ file: f, rel: '' }))));
    // drag & drop su tutta la pagina (file e cartelle)
    let depth = 0;
    document.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; document.body.classList.add('dragging'); } });
    document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', async e => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry ? i.webkitGetAsEntry() : null).filter(Boolean);
      const items = entries.length ? (await Promise.all(entries.map(en => walkEntry(en, '')))).flat()
                                   : [...e.dataTransfer.files].map(f => ({ file: f, rel: '' }));
      run(items);
    });
  }
  window.ShareUpload = { mount };
})();
