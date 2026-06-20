(() => {
  const app = document.getElementById('app');
  const CSRF = app.dataset.csrf;
  const CAN_WRITE = app.dataset.write === '1';
  const IS_ADMIN = app.dataset.admin === '1';
  const EDITOR_BUNDLE_V = app.dataset.edv || '1';
  const JSZIP_V = app.dataset.jszipv || '1';

  let cwd = '';            // percorso corrente (relativo alla radice)
  let items = [];          // elementi della cartella corrente
  const selected = new Set();
  let shareTimer = null;   // intervallo del conto alla rovescia nel pannello condivisioni
  let editorCleanup = null; // funzione di chiusura dell'editor note (stop sync/save)

  const $ = (s, r = document) => r.querySelector(s);
  const rowsEl = $('#rows'), emptyEl = $('#empty'), crumbsEl = $('#crumbs');
  const selbar = $('#selbar'), selCount = $('#selCount'), searchEl = $('#search');
  const modalBg = $('#modalBg');

  // Mostra a video qualunque errore JS imprevisto (diagnosi, invece di pagina "morta")
  window.addEventListener('error', e => { try { toast('Errore: ' + (e.message || (e.error && e.error.message) || e), true); } catch (_) {} });
  window.addEventListener('unhandledrejection', e => { try { toast('Errore: ' + ((e.reason && e.reason.message) || e.reason), true); } catch (_) {} });

  // ─── Helpers di rete ───────────────────────────────────────────────────
  async function apiGet(action, params = {}) {
    const q = new URLSearchParams({ action, ...params });
    const r = await fetch('api.php?' + q.toString());
    return r.json();
  }
  async function apiPost(action, data = {}) {
    const body = new FormData();
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) body.append(k, JSON.stringify(v)); else body.append(k, v);
    }
    const r = await fetch('api.php?action=' + action, { method: 'POST', headers: { 'X-CSRF': CSRF }, body });
    return r.json();
  }
  function toast(msg, isErr = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = msg; document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2600);
  }

  // ─── Icone per tipo / estensione ───────────────────────────────────────
  function iconFor(it) {
    if (it.type === 'dir') return 'ti-folder ico-dir';
    const ext = (it.name.split('.').pop() || '').toLowerCase();
    const map = {
      jpg: 'ti-photo', jpeg: 'ti-photo', png: 'ti-photo', gif: 'ti-photo', webp: 'ti-photo', svg: 'ti-photo',
      pdf: 'ti-file-type-pdf', doc: 'ti-file-type-doc', docx: 'ti-file-type-doc',
      xls: 'ti-file-type-xls', xlsx: 'ti-file-type-xls', csv: 'ti-file-type-csv',
      zip: 'ti-file-zip', rar: 'ti-file-zip', '7z': 'ti-file-zip', gz: 'ti-file-zip', tar: 'ti-file-zip',
      mp3: 'ti-music', wav: 'ti-music', mp4: 'ti-video', mov: 'ti-video',
      txt: 'ti-file-text', md: 'ti-file-text', php: 'ti-file-code', js: 'ti-file-code', html: 'ti-file-code', css: 'ti-file-code', json: 'ti-file-code',
    };
    return (map[ext] || 'ti-file') + ' ico-file';
  }

  // ─── Caricamento cartella ──────────────────────────────────────────────
  async function load(path = '') {
    const res = await apiGet('list', { path });
    if (!res.ok) { toast(res.error || 'Errore', true); return; }
    cwd = res.path === '/' ? '' : res.path.replace(/^\//, '');
    items = res.items;
    selected.clear();
    renderCrumbs(); renderRows(); updateSelbar();
  }

  function renderCrumbs() {
    const parts = cwd ? cwd.split('/') : [];
    let acc = '';
    let html = `<a data-path=""><i class="ti ti-home"></i> radice</a>`;
    parts.forEach((p, i) => {
      acc += (acc ? '/' : '') + p;
      html += `<span class="sep"><i class="ti ti-chevron-right"></i></span>`;
      html += (i === parts.length - 1)
        ? `<span class="cur">${esc(p)}</span>`
        : `<a data-path="${esc(acc)}">${esc(p)}</a>`;
    });
    crumbsEl.innerHTML = html;
    crumbsEl.querySelectorAll('a').forEach(a => a.onclick = () => load(a.dataset.path));
  }

  function renderRows() {
    const filter = searchEl.value.trim().toLowerCase();
    const shown = items.filter(it => !filter || it.name.toLowerCase().includes(filter));
    rowsEl.innerHTML = '';
    emptyEl.hidden = shown.length > 0;
    for (const it of shown) {
      const rel = (cwd ? cwd + '/' : '') + it.name;
      const row = document.createElement('div');
      row.className = 'row' + (selected.has(rel) ? ' sel' : '');
      const isDir = it.type === 'dir';
      const isText = !isDir && isTextFile(it.name);
      row.innerHTML = `
        <label class="cb"><input type="checkbox" ${selected.has(rel) ? 'checked' : ''}></label>
        <div class="name ${(isDir || isText) ? 'clickable' : ''}">
          <i class="ti ${iconFor(it)}"></i><span class="label" title="${esc(it.name)}">${esc(it.name)}</span>
        </div>
        <div class="size">${isDir ? '—' : esc(it.size_h)}</div>
        <div class="date">${esc(it.mtime)}</div>
        <div class="acts">
          ${isText ? '<i class="ti ti-edit" title="Modifica nota"></i>' : ''}
          <i class="ti ti-share" title="Condividi"></i>
          <i class="ti ti-download" title="Scarica"></i>
          ${CAN_WRITE ? '<i class="ti ti-pencil" title="Rinomina"></i><i class="ti ti-trash" title="Elimina"></i>' : ''}
        </div>`;
      // checkbox
      row.querySelector('input').onchange = e => {
        e.target.checked ? selected.add(rel) : selected.delete(rel);
        row.classList.toggle('sel', e.target.checked); updateSelbar();
      };
      // apri cartella o nota
      if (isDir) row.querySelector('.label').onclick = () => load(rel);
      else if (isText) row.querySelector('.label').onclick = () => openEditor(rel, it.name);
      if (isText) row.querySelector('.ti-edit').onclick = () => openEditor(rel, it.name);
      // azioni
      row.querySelector('.ti-download').onclick = () => {
        if (isDir) startZip([rel]); else window.location = 'api.php?action=download&path=' + encodeURIComponent(rel);
      };
      row.querySelector('.ti-share').onclick = () => shareDialog(rel, it.name);
      if (CAN_WRITE) {
        row.querySelector('.ti-pencil').onclick = () => renameDialog(it.name, rel);
        row.querySelector('.ti-trash').onclick = () => deleteDialog([rel], it.name);
      }
      rowsEl.appendChild(row);
    }
    $('#checkAll').checked = shown.length > 0 && shown.every(it => selected.has((cwd ? cwd + '/' : '') + it.name));
  }

  function updateSelbar() {
    selbar.hidden = selected.size === 0;
    selCount.textContent = selected.size + (selected.size === 1 ? ' elemento selezionato' : ' elementi selezionati');
  }

  // ─── Download ZIP ──────────────────────────────────────────────────────
  // Fallback storico: lo ZIP è costruito e servito dal SERVER (qualsiasi backend).
  function downloadZip(paths) {
    if (!paths.length) { toast('Niente da scaricare', true); return; }
    const q = new URLSearchParams();
    q.set('action', 'zip');
    paths.forEach(p => q.append('paths[]', p));
    window.location = 'api.php?' + q.toString();
  }

  // Carica JSZip in locale (vendorizzato, lazy: un solo <script> al primo uso).
  let _jszipLoading = null;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (_jszipLoading) return _jszipLoading;
    _jszipLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'assets/vendor/jszip.min.js?v=' + JSZIP_V;
      s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip non disponibile'));
      s.onerror = () => reject(new Error('Impossibile caricare JSZip'));
      document.head.appendChild(s);
    });
    return _jszipLoading;
  }

  // Costruisce lo ZIP nel BROWSER scaricando ogni file DIRETTAMENTE da Wasabi
  // (presigned GET). Su qualsiasi errore (rete/CORS/JSZip) → fallback server-zip
  // trasparente: l'esperienza utente non cambia.
  async function clientZip(manifest) {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const f of manifest.files) {
      if (!f.url) { zip.folder(f.name.replace(/\/$/, '')); continue; }   // marker cartella vuota
      const r = await fetch(f.url);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + f.name);
      zip.file(f.name, await r.blob(), { compression: 'STORE' });        // STORE: niente ricompressione
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a = document.createElement('a');
    const u = URL.createObjectURL(blob);
    a.href = u; a.download = manifest.zipname || 'download.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  // Entry point dei download ZIP: prova il client-zip (banda server ~zero su S3),
  // con fallback automatico al server-zip su mode:'server' o qualsiasi errore.
  async function startZip(paths) {
    if (!paths.length) { toast('Niente da scaricare', true); return; }
    let manifest = null;
    try {
      const q = new URLSearchParams();
      q.set('action', 'zip_manifest');
      paths.forEach(p => q.append('paths[]', p));
      const r = await fetch('api.php?' + q.toString());
      manifest = await r.json();
    } catch (_) { manifest = null; }
    if (!manifest || !manifest.ok || manifest.mode !== 'client' || !Array.isArray(manifest.files)) {
      downloadZip(paths); return;                                        // server-zip (locale o oltre i limiti)
    }
    try {
      toast('Preparazione ZIP…');
      await clientZip(manifest);
    } catch (e) {
      downloadZip(paths);                                               // CORS/rete/JSZip → server-zip
    }
  }

  // ─── Dialog generico ───────────────────────────────────────────────────
  function openModal(html) {
    modalBg.innerHTML = html; modalBg.hidden = false;
    modalBg.onclick = e => { if (e.target === modalBg) closeModal(); };
    const first = modalBg.querySelector('input,textarea,select'); if (first) first.focus();
  }
  function closeModal() {
    if (shareTimer) { clearInterval(shareTimer); shareTimer = null; }
    if (editorCleanup) { try { editorCleanup(); } catch (_) {} editorCleanup = null; }
    modalBg.hidden = true; modalBg.innerHTML = '';
  }
  window.closeModal = closeModal;

  function promptDialog(title, icon, label, placeholder, onok, okText = 'Crea') {
    openModal(`<div class="modal"><h3><i class="ti ${icon}"></i> ${esc(title)}</h3>
      <label>${esc(label)}</label><input type="text" id="m_input" placeholder="${esc(placeholder)}">
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
        <button class="btn btn-primary" id="m_ok">${esc(okText)}</button></div></div>`);
    const input = $('#m_input', modalBg);
    const go = async () => {
      const val = input.value.trim(); if (!val) return;
      const res = await onok(val);
      if (res && res.ok) { closeModal(); load(cwd); } else toast(res && res.error || 'Errore', true);
    };
    $('#m_ok', modalBg).onclick = go;
    input.onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  function newFolderDialog() {
    promptDialog('Nuova cartella', 'ti-folder-plus', 'Nome cartella', 'es. documenti',
      name => apiPost('mkdir', { path: cwd, name }));
  }
  function newFileDialog() {
    openModal(`<div class="modal"><h3><i class="ti ti-file-plus"></i> Nuovo file</h3>
      <label>Nome file</label><input type="text" id="f_name" placeholder="es. note.txt">
      <label>Contenuto (opzionale)</label><textarea id="f_body"></textarea>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
        <button class="btn btn-primary" id="f_ok">Crea</button></div></div>`);
    $('#f_ok', modalBg).onclick = async () => {
      const name = $('#f_name', modalBg).value.trim(); if (!name) return;
      const res = await apiPost('newfile', { path: cwd, name, content: $('#f_body', modalBg).value });
      if (res.ok) { closeModal(); load(cwd); } else toast(res.error || 'Errore', true);
    };
  }
  function renameDialog(oldName, rel) {
    promptDialog('Rinomina', 'ti-pencil', 'Nuovo nome', oldName,
      name => apiPost('rename', { from: rel, to: name }), 'Rinomina');
    const input = $('#m_input', modalBg); input.value = oldName; input.select();
  }
  function deleteDialog(paths, label) {
    const what = paths.length === 1 ? `"${esc(label || paths[0])}"` : `${paths.length} elementi`;
    openModal(`<div class="modal"><div class="center"><div class="warn-ico"><i class="ti ti-alert-triangle"></i></div>
      <h3 style="justify-content:center">Eliminare ${what}?</h3>
      <p class="muted">L'operazione è definitiva e non reversibile.</p></div>
      <div class="modal-actions" style="justify-content:center">
        <button class="btn" onclick="closeModal()">Annulla</button>
        <button class="btn btn-danger" id="d_ok"><i class="ti ti-trash"></i> Elimina</button></div></div>`);
    $('#d_ok', modalBg).onclick = async () => {
      const res = await apiPost('delete', { paths });
      if (res.ok) { closeModal(); toast(`Eliminati: ${res.deleted}`); load(cwd); }
      else toast(res.error || 'Errore', true);
    };
  }

  // ─── Upload a chunk, parallelo + ripresa (file e cartelle) ─────────────
  const CHUNK = 16 * 1024 * 1024;   // 16 MB per blocco
  const CONC = 3;                   // blocchi in parallelo per file
  const MAX_RETRY = 5;

  function fmtBytes(b) { if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1, v = b; do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1); return v.toFixed(1) + ' ' + u[i]; }
  function relDir(p) { if (!p) return ''; const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
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

  // items: [{file, rel}] — rel è la sottocartella relativa alla cartella corrente
  function uploadItems(items) {
    if (!CAN_WRITE || !items.length) return;
    openModal(`<div class="modal"><h3><i class="ti ti-upload"></i> Caricamento (${items.length})</h3>
      <div id="up_list" style="max-height:340px;overflow:auto"></div>
      <div class="modal-actions"><button class="btn" id="up_close" disabled>Chiudi</button></div></div>`);
    const list = $('#up_list', modalBg);
    const rows = items.map(it => {
      const label = (it.rel ? it.rel + '/' : '') + it.file.name;
      const row = document.createElement('div');
      row.style.margin = '10px 0';
      row.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</span>
          <span class="up-stat" style="flex:none;color:var(--muted)">in attesa</span></div>
        <div class="progress"><div></div></div>`;
      list.appendChild(row);
      return { it, bar: row.querySelector('.progress > div'), stat: row.querySelector('.up-stat'), done: false };
    });
    const closeBtn = $('#up_close', modalBg);
    (async () => {
      for (const r of rows) {
        try { await uploadOne(r); r.done = true; r.stat.textContent = 'completato'; r.stat.style.color = 'var(--ok)'; }
        catch (e) { r.stat.textContent = 'errore: ' + (e.message || e); r.stat.style.color = 'var(--danger)'; }
      }
      closeBtn.disabled = false;
      closeBtn.onclick = () => { closeModal(); load(cwd); };
      load(cwd);
    })();
  }

  async function uploadOne(r) {
    const f = r.it.file;
    const dir = [cwd, r.it.rel].filter(Boolean).join('/');
    const uid = await fileUid(dir, f);
    let chunkSize = CHUNK; const doneSet = new Set();
    try {
      const st = await fetch('api.php?action=upload_status&uid=' + uid).then(x => x.json());
      if (st.ok) { if (st.chunk > 0) chunkSize = st.chunk; (st.parts || []).forEach(i => doneSet.add(i)); }
    } catch (_) {}
    const count = Math.max(1, Math.ceil(f.size / chunkSize));
    const lenOf = i => Math.min(chunkSize, f.size - i * chunkSize);
    let doneBytes = 0; doneSet.forEach(i => doneBytes += lenOf(i));
    if (doneSet.size > 0 && doneSet.size < count) r.stat.textContent = 'ripresa…';
    const missing = []; for (let i = 0; i < count; i++) if (!doneSet.has(i)) missing.push(i);
    const live = new Map();
    const refresh = () => { let l = 0; live.forEach(v => l += v); setProg(r, doneBytes + l, f.size); };
    refresh();
    let next = 0, failed = null;
    const worker = async () => {
      while (next < missing.length && !failed) {
        const idx = missing[next++];
        const offset = idx * chunkSize, end = Math.min(offset + chunkSize, f.size);
        try {
          await sendChunk(uid, idx, offset, chunkSize, f.size, f.slice(offset, end), loaded => { live.set(idx, loaded); refresh(); });
          live.delete(idx); doneBytes += (end - offset); refresh();
        } catch (e) { failed = e; live.delete(idx); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, missing.length || 1) }, worker));
    if (failed) throw failed;
    const fin = await apiPost('upload_finish', { uid, path: dir, name: f.name, total: f.size, chunk_size: chunkSize });
    if (!fin.ok) throw new Error(fin.error || 'finalizzazione fallita');
  }

  function sendChunk(uid, index, offset, chunkSize, total, blob, onProg, attempt = 0) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'api.php?action=upload_chunk');
      xhr.setRequestHeader('X-CSRF', CSRF);
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProg) onProg(e.loaded); };
      const retry = () => { if (attempt < MAX_RETRY) setTimeout(() => sendChunk(uid, index, offset, chunkSize, total, blob, onProg, attempt + 1).then(resolve, reject), 800 * (attempt + 1)); else reject(new Error('connessione interrotta')); };
      xhr.onload = () => {
        let r = {}; try { r = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status === 200 && r.ok) resolve(r);
        else if (xhr.status >= 500 || xhr.status === 0) retry();
        else reject(new Error(r.error || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = retry;
      const fd = new FormData();
      fd.append('uid', uid); fd.append('index', index); fd.append('offset', offset);
      fd.append('chunk_size', chunkSize); fd.append('total', total); fd.append('chunk', blob);
      xhr.send(fd);
    });
  }

  function setProg(r, done, total) {
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 100;
    r.bar.style.width = pct + '%';
    if (!r.done && r.stat.style.color !== 'var(--danger)') r.stat.textContent = pct + '% · ' + fmtBytes(done) + ' / ' + fmtBytes(total);
  }

  // Espande cartelle trascinate (entry API) in una lista piatta {file, rel}
  function walkEntry(entry, parentPath) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(f => resolve([{ file: f, rel: parentPath }]), () => resolve([]));
      } else if (entry.isDirectory) {
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

  // ─── Pannello utenti (admin) ───────────────────────────────────────────
  function fmtTime(iso) { try { return new Date(iso).toLocaleString('it-IT'); } catch (_) { return iso; } }

  async function adminPanel(section) {
    section = section || 'users';
    const tab = (k, ic, lbl) => `<button class="btn ${section === k ? 'btn-primary' : ''}" data-sec="${k}"><i class="ti ${ic}"></i> ${lbl}</button>`;
    openModal(`<div class="modal wide"><h3><i class="ti ti-settings"></i> Amministrazione</h3>
      <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
        ${tab('users', 'ti-users-group', 'Utenti')}${tab('settings', 'ti-adjustments', 'Impostazioni')}${tab('audit', 'ti-history', 'Registro')}
      </div>
      <div id="adm_body">Caricamento…</div>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    modalBg.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => adminPanel(b.dataset.sec));
    const body = $('#adm_body', modalBg);
    if (section === 'settings') await renderSettingsSection(body);
    else if (section === 'audit') await renderAuditSection(body);
    else await renderUsersSection(body);
  }

  async function renderUsersSection(body, usageRefresh) {
    const useParams = usageRefresh ? { refresh: usageRefresh } : {};
    const [res, use] = await Promise.all([apiGet('users_list'), apiGet('usage_list', useParams)]);
    if (!res.ok) { body.textContent = res.error || 'Errore'; return; }
    const usage = {};
    if (use && use.ok) use.users.forEach(u => usage[u.username] = u);
    const spaceCell = (name) => {
      const u = usage[name];
      if (!u) return '<span class="muted">—</span>';
      if (!u.quota) return `${esc(u.usage_h)} <span class="muted">/ illimitata</span>${u.stale ? ' <span class="muted" title="valore in cache">~</span>' : ''}`;
      const pct = u.pct == null ? 0 : u.pct;
      const cls = pct >= 100 ? 'q-red' : (pct >= 80 ? 'q-amber' : 'q-green');
      return `<div class="quota-bar"><div class="${cls}" style="width:${Math.min(100, pct)}%"></div></div>`
        + `<span class="quota-txt">${esc(u.usage_h)} / ${esc(u.quota_h)} (${pct}%)${u.stale ? ' ~' : ''}</span>`;
    };
    const rows = res.users.map(u => `
      <tr><td><i class="ti ti-user"></i> ${esc(u.username)}</td>
        <td>${u.role === 'admin' ? '<b>admin</b>' : 'utente'}</td>
        <td>${u.permission === 'write' ? 'lettura e scrittura' : 'sola lettura'}</td>
        <td class="uspace">${spaceCell(u.username)}</td>
        <td class="uact">
          <i class="ti ti-refresh" title="Aggiorna spazio" data-refresh="${esc(u.username)}"></i>
          <i class="ti ti-edit" data-u="${esc(u.username)}" data-r="${u.role}" data-p="${u.permission}" data-q="${u.quota_mb || 0}"></i>
          <i class="ti ti-trash" data-del="${esc(u.username)}"></i></td></tr>`).join('');
    body.innerHTML = `<div style="text-align:right;margin-bottom:8px"><button class="btn btn-primary" id="u_new"><i class="ti ti-user-plus"></i> Nuovo utente</button></div>
      <table class="utable"><thead><tr><th>Utente</th><th>Ruolo</th><th>Permessi</th><th>Spazio</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    $('#u_new', modalBg).onclick = () => userForm();
    modalBg.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`Eliminare l'utente "${b.dataset.del}"?`)) return;
      const r = await apiPost('user_delete', { username: b.dataset.del });
      if (r.ok) { toast('Utente eliminato'); adminPanel('users'); } else toast(r.error || 'Errore', true);
    });
    modalBg.querySelectorAll('[data-refresh]').forEach(b => b.onclick = () => renderUsersSection(body, b.dataset.refresh));
    modalBg.querySelectorAll('[data-u]').forEach(b => b.onclick = () =>
      userForm({ username: b.dataset.u, role: b.dataset.r, permission: b.dataset.p, quota_mb: parseInt(b.dataset.q || '0', 10) }));
  }

  async function renderSettingsSection(body) {
    const s = await apiGet('settings_get');
    if (!s.ok) { body.textContent = s.error || 'Errore'; return; }
    const st = s.storage || { backend: 'local' };
    const isS3 = st.backend === 's3';
    body.innerHTML = `
      <label>Titolo del sito</label>
      <input type="text" id="set_title" value="${esc(s.site_title)}" maxlength="40" placeholder="Share">
      <label style="margin-top:10px">Intervallo di sincronizzazione note (ms)</label>
      <input type="text" id="set_poll" value="${s.note_poll_ms}">
      <label style="margin-top:10px">Dimensione massima di una nota (MB)</label>
      <input type="text" id="set_maxmb" value="${Math.round(s.note_max_bytes / 1048576)}">
      <label style="margin-top:10px">Quota predefinita per nuovo utente (MB, 0 = illimitata)</label>
      <input type="text" id="set_defquota" value="${Math.round((s.default_quota_bytes || 0) / 1048576)}">

      <h3 style="margin:18px 0 4px;font-size:15px;display:flex;align-items:center;gap:6px"><i class="ti ti-database"></i> Archiviazione file</h3>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Dove vengono salvati i file caricati. S3 usa uno storage esterno compatibile (es. Wasabi).</p>
      <label>Backend</label>
      <select id="set_backend">
        <option value="local"${isS3 ? '' : ' selected'}>Locale (server)</option>
        <option value="s3"${isS3 ? ' selected' : ''}>S3 compatibile (Wasabi)</option>
      </select>
      <div id="s3_box" style="margin-top:10px${isS3 ? '' : ';display:none'}">
        <label>Endpoint</label>
        <input type="text" id="s3_endpoint" value="${esc(st.endpoint || '')}" placeholder="s3.eu-south-1.wasabisys.com">
        <label style="margin-top:8px">Regione</label>
        <input type="text" id="s3_region" value="${esc(st.region || '')}" placeholder="eu-south-1">
        <label style="margin-top:8px">Bucket</label>
        <input type="text" id="s3_bucket" value="${esc(st.bucket || '')}" placeholder="desotech-desoshare">
        <label style="margin-top:8px">Access Key ID</label>
        <input type="text" id="s3_key" value="${esc(st.access_key || '')}" autocomplete="off">
        <label style="margin-top:8px">Secret Access Key</label>
        <input type="password" id="s3_secret" value="" autocomplete="new-password" placeholder="${st.has_secret ? '•••••••• (invariato)' : 'inserisci il secret'}">
        <p class="muted" style="font-size:12px;margin:4px 0 0">Lascia vuoto il secret per non modificarlo. È salvato cifrato sul server.</p>
        <div style="margin-top:8px"><button class="btn" id="s3_testbtn"><i class="ti ti-plug-connected"></i> Prova connessione</button> <span id="s3_testmsg" class="muted" style="font-size:12px"></span></div>
      </div>

      <div style="margin-top:16px;text-align:right"><button class="btn btn-primary" id="set_save"><i class="ti ti-device-floppy"></i> Salva</button></div>`;

    const backendSel = $('#set_backend', modalBg);
    backendSel.onchange = () => { $('#s3_box', modalBg).style.display = backendSel.value === 's3' ? '' : 'none'; };

    const s3fields = () => ({
      storage_backend: backendSel.value,
      s3_endpoint: $('#s3_endpoint', modalBg) ? $('#s3_endpoint', modalBg).value : '',
      s3_region:   $('#s3_region', modalBg)   ? $('#s3_region', modalBg).value   : '',
      s3_bucket:   $('#s3_bucket', modalBg)   ? $('#s3_bucket', modalBg).value   : '',
      s3_key:      $('#s3_key', modalBg)      ? $('#s3_key', modalBg).value      : '',
      s3_secret:   $('#s3_secret', modalBg)   ? $('#s3_secret', modalBg).value   : '',
    });

    const testBtn = $('#s3_testbtn', modalBg);
    if (testBtn) testBtn.onclick = async () => {
      const msg = $('#s3_testmsg', modalBg);
      msg.textContent = 'verifica in corso…'; msg.style.color = '';
      const r = await apiPost('s3_test', s3fields());
      msg.textContent = r.ok ? (r.message || 'Connessione riuscita') : (r.error || 'Connessione fallita');
      msg.style.color = r.ok ? 'var(--ok, #1a7f37)' : 'var(--danger, #c0392b)';
    };

    $('#set_save', modalBg).onclick = async () => {
      const r = await apiPost('settings_save', Object.assign({
        site_title: $('#set_title', modalBg).value,
        note_poll_ms: $('#set_poll', modalBg).value,
        note_max_mb: $('#set_maxmb', modalBg).value,
        default_quota_mb: $('#set_defquota', modalBg).value,
      }, s3fields()));
      if (r.ok) toast('Impostazioni salvate'); else toast(r.error || 'Errore', true);
    };
  }

  async function renderAuditSection(body) {
    const r = await apiGet('audit_list');
    if (!r.ok) { body.textContent = r.error || 'Errore'; return; }
    if (!r.entries.length) { body.innerHTML = '<p class="muted">Nessuna attività registrata.</p>'; return; }
    body.innerHTML = `<div style="max-height:360px;overflow:auto"><table class="utable">
      <thead><tr><th>Quando</th><th>Utente</th><th>Azione</th><th>Dettaglio</th></tr></thead><tbody>${
      r.entries.map(e => `<tr><td style="white-space:nowrap">${esc(fmtTime(e.time))}</td><td>${esc(e.user)}</td><td>${esc(e.action)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('')
      }</tbody></table></div>`;
  }

  function userForm(u = null) {
    const editing = !!u;
    const perm = u ? u.permission : 'read';
    const isAdminRole = u ? u.role === 'admin' : false;
    openModal(`<div class="modal"><h3><i class="ti ti-user-plus"></i> ${editing ? 'Modifica utente' : 'Nuovo utente'}</h3>
      <label>Username</label><input type="text" id="u_name" value="${u ? esc(u.username) : ''}" ${editing ? 'readonly' : ''}>
      <label>Password ${editing ? '(lascia vuoto per non cambiarla)' : ''}</label>
      <input type="text" id="u_pass" placeholder="${editing ? '••••••' : 'almeno 6 caratteri'}">
      <label>Permessi</label>
      <div class="perm-row" id="u_perm">
        <div class="perm-opt ${perm === 'read' ? 'active' : ''}" data-v="read"><i class="ti ti-eye"></i> Sola lettura</div>
        <div class="perm-opt ${perm === 'write' ? 'active' : ''}" data-v="write"><i class="ti ti-pencil"></i> Lettura e scrittura</div>
      </div>
      <label style="margin-top:12px">Quota di archiviazione (MB, 0 = illimitata)</label>
      <input type="text" id="u_quota" value="${u && u.quota_mb ? u.quota_mb : 0}">
      <label style="margin-top:12px"><input type="checkbox" id="u_admin" ${isAdminRole ? 'checked' : ''}> Amministratore (gestione utenti + accesso completo)</label>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
        <button class="btn btn-primary" id="u_save">Salva</button></div></div>`);
    let chosen = perm;
    modalBg.querySelectorAll('.perm-opt').forEach(o => o.onclick = () => {
      chosen = o.dataset.v;
      modalBg.querySelectorAll('.perm-opt').forEach(x => x.classList.toggle('active', x === o));
    });
    $('#u_save', modalBg).onclick = async () => {
      const data = {
        username: $('#u_name', modalBg).value.trim(),
        password: $('#u_pass', modalBg).value,
        permission: chosen,
        role: $('#u_admin', modalBg).checked ? 'admin' : 'user',
        quota_mb: $('#u_quota', modalBg).value.trim(),
      };
      if (editing) data.original = u.username;
      const r = await apiPost('user_save', data);
      if (r.ok) { toast('Utente salvato'); adminPanel('users'); } else toast(r.error || 'Errore', true);
    };
  }

  // ─── Condivisioni (link a scadenza) ────────────────────────────────────
  function copyText(t) {
    try { navigator.clipboard.writeText(t); }
    catch (_) { const i = document.createElement('textarea'); i.value = t; document.body.appendChild(i); i.select(); try { document.execCommand('copy'); } catch (e) {} i.remove(); }
  }
  function fmtDuration(s) {
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    if (d > 0) return d + 'g ' + h + 'h'; if (h > 0) return h + 'h ' + m + 'm'; if (m > 0) return m + 'm ' + x + 's'; return x + 's';
  }
  function shareDialog(rel, name) {
    const canEdit = isTextFile(name);
    openModal(`<div class="modal"><h3><i class="ti ti-share"></i> Condividi "${esc(name)}"</h3>
      <label>Durata del link</label>
      <select id="sh_ttl">
        <option value="3600">1 ora</option>
        <option value="86400" selected>24 ore</option>
        <option value="604800">7 giorni</option>
        <option value="2592000">30 giorni</option>
      </select>
      ${canEdit ? `<label style="margin-top:10px">Accesso</label>
      <select id="sh_mode">
        <option value="view">Sola lettura</option>
        <option value="edit">Modificabile (chiunque abbia il link co-edita)</option>
      </select>` : ''}
      <div id="sh_result" style="margin-top:12px"></div>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button>
        <button class="btn btn-primary" id="sh_create"><i class="ti ti-link"></i> Crea link</button></div></div>`);
    $('#sh_create', modalBg).onclick = async () => {
      const ttl = $('#sh_ttl', modalBg).value;
      const mode = canEdit ? $('#sh_mode', modalBg).value : 'view';
      const r = await apiPost('share_create', { path: rel, ttl, mode });
      if (!r.ok) { toast(r.error || 'Errore', true); return; }
      const when = new Date(r.expires_at * 1000).toLocaleString('it-IT');
      $('#sh_result', modalBg).innerHTML = `<label>Link pubblico (${mode === 'edit' ? 'modificabile' : 'sola lettura'}) — scade il ${esc(when)}</label>
        <div style="display:flex;gap:6px"><input type="text" id="sh_url" readonly value="${esc(r.url)}" style="flex:1">
        <button class="btn" id="sh_copy" title="Copia"><i class="ti ti-copy"></i></button></div>`;
      const inp = $('#sh_url', modalBg); inp.focus(); inp.select();
      $('#sh_copy', modalBg).onclick = () => { copyText(r.url); toast('Link copiato'); };
    };
  }
  async function sharesPanel() {
    const r = await apiGet('share_list');
    if (!r.ok) { toast(r.error || 'Errore', true); return; }
    const body = r.shares.length ? `<table class="utable"><thead><tr><th>Elemento</th><th>Scade</th><th></th></tr></thead><tbody>${
      r.shares.map(s => `<tr data-exp="${s.expires_at}">
        <td><i class="ti ${s.type === 'dir' ? 'ti-folder' : 'ti-file'}"></i> ${esc(s.name)}${s.mode === 'edit' ? ' <span class="muted" style="font-size:11px">· modificabile</span>' : ''}${r.is_admin ? ` <span class="muted" style="font-size:11px">(${esc(s.created_by)})</span>` : ''}</td>
        <td class="sh-rem" style="white-space:nowrap"></td>
        <td class="uact" style="white-space:nowrap">
          <i class="ti ti-copy" data-url="${esc(s.url)}" title="Copia link"></i>
          <i class="ti ti-trash" data-revoke="${esc(s.token)}" title="Revoca"></i></td></tr>`).join('')
      }</tbody></table>` : '<p class="muted">Nessuna condivisione attiva.</p>';
    openModal(`<div class="modal wide"><h3><i class="ti ti-share"></i> Condivisioni attive</h3>${body}
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    modalBg.querySelectorAll('[data-url]').forEach(b => b.onclick = () => { copyText(b.dataset.url); toast('Link copiato'); });
    modalBg.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
      if (!confirm('Revocare questa condivisione? Il link smetterà di funzionare.')) return;
      const x = await apiPost('share_revoke', { token: b.dataset.revoke });
      if (x.ok) { toast('Condivisione revocata'); sharesPanel(); } else toast(x.error || 'Errore', true);
    });
    if (shareTimer) clearInterval(shareTimer);
    const tick = () => {
      modalBg.querySelectorAll('tr[data-exp]').forEach(tr => {
        const rem = tr.dataset.exp - Date.now() / 1000;
        const cell = tr.querySelector('.sh-rem');
        if (rem <= 0) tr.remove(); else if (cell) cell.textContent = 'tra ' + fmtDuration(rem);
      });
    };
    tick(); shareTimer = setInterval(tick, 1000);
  }

  // ─── Editor di note collaborativo (CodeMirror 6 + Yjs via CDN) ─────────
  const BIN_EXT = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','svgz','pdf','zip','rar','7z','gz','tgz','tar','bz2','mp3','wav','ogg','flac','mp4','mov','avi','mkv','webm','exe','dll','so','bin','dat','class','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','woff','woff2','ttf','otf','eot','psd','ai','eps']);
  function isTextFile(name) { return !BIN_EXT.has((name.split('.').pop() || '').toLowerCase()); }
  const b64ToU8 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));

  async function openEditor(rel, name) {
    if (editorCleanup) closeModal();
    openModal(`<div class="modal editor-modal"><h3 style="justify-content:space-between">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-edit"></i> ${esc(name)}</span>
        <span id="ed_status" class="muted" style="font-size:12px;font-weight:400;flex:none">apertura…</span></h3>
      <div id="ed_host" class="editor-host"></div>
      <div class="modal-actions" style="justify-content:space-between;align-items:center">
        <span id="ed_pres" class="muted" style="font-size:12px"></span>
        <button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    const host = $('#ed_host', modalBg), statusEl = $('#ed_status', modalBg), presEl = $('#ed_pres', modalBg);
    const info = await apiGet('note_open', { path: rel });
    if (!info.ok) { statusEl.textContent = ''; host.innerHTML = '<div style="padding:14px">' + esc(info.error || 'Errore') + '</div>'; return; }
    let E = null;
    try { E = await NoteEditor.loadBundle('assets/editor-bundle.js?v=' + EDITOR_BUNDLE_V); } catch (e) { E = null; }
    if (E) {
      editorCleanup = NoteEditor.mount({
        host, statusEl, presEl, info,
        sync: payload => apiPost('note_sync', Object.assign({ path: rel }, payload)),
        save: content => apiPost('note_save', { path: rel, content }),
      });
    } else {
      editorFallback(rel, info, host, statusEl);
    }
  }

  // Fallback: se il bundle non si carica, editor semplice (singolo utente, niente real-time)
  function editorFallback(rel, info, host, statusEl) {
    statusEl.textContent = info.editable ? 'editor semplice' : 'sola lettura';
    const text = info.text ? new TextDecoder().decode(b64ToU8(info.text)) : '';
    host.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.value = text; ta.readOnly = !info.editable;
    ta.style.cssText = 'width:100%;height:100%;border:0;outline:none;resize:none;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:10px;box-sizing:border-box';
    host.appendChild(ta);
    let t = null, dirty = false;
    if (info.editable) ta.oninput = () => { dirty = true; clearTimeout(t); t = setTimeout(async () => { if (!dirty) return; dirty = false; const r = await apiPost('note_save', { path: rel, content: ta.value }); statusEl.textContent = r.ok ? 'salvato' : 'errore salvataggio'; }, 1500); };
    editorCleanup = () => { clearTimeout(t); };
  }

  function newNoteDialog() {
    openModal(`<div class="modal"><h3><i class="ti ti-note"></i> Nuova nota</h3>
      <label>Nome nota</label><input type="text" id="nn_name" placeholder="es. appunti.md">
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
        <button class="btn btn-primary" id="nn_ok"><i class="ti ti-edit"></i> Crea e apri</button></div></div>`);
    const go = async () => {
      let name = $('#nn_name', modalBg).value.trim(); if (!name) return;
      if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
      const r = await apiPost('newfile', { path: cwd, name, content: '' });
      if (!r.ok) { toast(r.error || 'Errore', true); return; }
      const rel = (cwd ? cwd + '/' : '') + name;
      closeModal(); load(cwd); openEditor(rel, name);
    };
    $('#nn_ok', modalBg).onclick = go;
    $('#nn_name', modalBg).onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  // ─── Wiring toolbar ────────────────────────────────────────────────────
  if (CAN_WRITE) {
    $('#btnUpload').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { uploadItems(Array.from(e.target.files).map(f => ({ file: f, rel: '' }))); e.target.value = ''; };
    $('#btnUploadFolder') && ($('#btnUploadFolder').onclick = () => $('#folderInput').click());
    $('#folderInput') && ($('#folderInput').onchange = e => { uploadItems(Array.from(e.target.files).map(f => ({ file: f, rel: relDir(f.webkitRelativePath) }))); e.target.value = ''; });
    $('#btnNewFolder').onclick = newFolderDialog;
    $('#btnNewFile').onclick = newFileDialog;
    $('#btnNewNote') && ($('#btnNewNote').onclick = newNoteDialog);
    $('#btnDelSel') && ($('#btnDelSel').onclick = () => deleteDialog([...selected]));
  }
  $('#btnRefresh').onclick = () => load(cwd);
  $('#btnShares') && ($('#btnShares').onclick = sharesPanel);
  $('#btnZipCurrent').onclick = () => startZip(selected.size ? [...selected] : [cwd || '']);
  $('#btnZipSel').onclick = () => startZip([...selected]);
  if (IS_ADMIN) $('#btnAdmin') && ($('#btnAdmin').onclick = () => adminPanel('users'));
  searchEl.oninput = renderRows;
  $('#checkAll').onchange = e => {
    const filter = searchEl.value.trim().toLowerCase();
    items.filter(it => !filter || it.name.toLowerCase().includes(filter))
      .forEach(it => { const rel = (cwd ? cwd + '/' : '') + it.name; e.target.checked ? selected.add(rel) : selected.delete(rel); });
    renderRows(); updateSelbar();
  };

  // drag & drop
  let dragDepth = 0;
  if (CAN_WRITE) {
    window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) document.body.classList.remove('dragging'); });
    window.addEventListener('drop', e => {
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      const dt = e.dataTransfer;
      const entries = dt.items && dt.items.length && dt.items[0].webkitGetAsEntry
        ? Array.from(dt.items).map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean) : [];
      if (entries.length) {
        Promise.all(entries.map(en => walkEntry(en, ''))).then(lists => {
          const items = lists.flat();
          if (items.length) uploadItems(items);
        });
      } else if (dt.files && dt.files.length) {
        uploadItems(Array.from(dt.files).map(f => ({ file: f, rel: '' })));
      }
    });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modalBg.hidden) closeModal(); });

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  load('');
})();
