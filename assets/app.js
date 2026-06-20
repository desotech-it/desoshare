(() => {
  const app = document.getElementById('app');
  const CSRF = app.dataset.csrf;
  const CAN_WRITE = app.dataset.write === '1';
  const IS_ADMIN = app.dataset.admin === '1';

  let cwd = '';            // percorso corrente (relativo alla radice)
  let items = [];          // elementi della cartella corrente
  const selected = new Set();
  let shareTimer = null;   // intervallo del conto alla rovescia nel pannello condivisioni

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
      row.innerHTML = `
        <label class="cb"><input type="checkbox" ${selected.has(rel) ? 'checked' : ''}></label>
        <div class="name ${isDir ? 'clickable' : ''}">
          <i class="ti ${iconFor(it)}"></i><span class="label" title="${esc(it.name)}">${esc(it.name)}</span>
        </div>
        <div class="size">${isDir ? '—' : esc(it.size_h)}</div>
        <div class="date">${esc(it.mtime)}</div>
        <div class="acts">
          <i class="ti ti-share" title="Condividi"></i>
          <i class="ti ti-download" title="Scarica"></i>
          ${CAN_WRITE ? '<i class="ti ti-pencil" title="Rinomina"></i><i class="ti ti-trash" title="Elimina"></i>' : ''}
        </div>`;
      // checkbox
      row.querySelector('input').onchange = e => {
        e.target.checked ? selected.add(rel) : selected.delete(rel);
        row.classList.toggle('sel', e.target.checked); updateSelbar();
      };
      // apri cartella
      if (isDir) row.querySelector('.label').onclick = () => load(rel);
      // azioni
      row.querySelector('.ti-download').onclick = () => {
        if (isDir) downloadZip([rel]); else window.location = 'api.php?action=download&path=' + encodeURIComponent(rel);
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
  function downloadZip(paths) {
    if (!paths.length) { toast('Niente da scaricare', true); return; }
    const q = new URLSearchParams();
    q.set('action', 'zip');
    paths.forEach(p => q.append('paths[]', p));
    window.location = 'api.php?' + q.toString();
  }

  // ─── Dialog generico ───────────────────────────────────────────────────
  function openModal(html) {
    modalBg.innerHTML = html; modalBg.hidden = false;
    modalBg.onclick = e => { if (e.target === modalBg) closeModal(); };
    const first = modalBg.querySelector('input,textarea,select'); if (first) first.focus();
  }
  function closeModal() { if (shareTimer) { clearInterval(shareTimer); shareTimer = null; } modalBg.hidden = true; modalBg.innerHTML = ''; }
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
  async function usersPanel() {
    const res = await apiGet('users_list');
    if (!res.ok) { toast(res.error || 'Errore', true); return; }
    const rows = res.users.map(u => `
      <tr><td><i class="ti ti-user"></i> ${esc(u.username)}</td>
        <td>${u.role === 'admin' ? '<b>admin</b>' : 'utente'}</td>
        <td>${u.permission === 'write' ? 'lettura e scrittura' : 'sola lettura'}</td>
        <td class="uact">
          <i class="ti ti-edit" data-u="${esc(u.username)}" data-r="${u.role}" data-p="${u.permission}"></i>
          <i class="ti ti-trash" data-del="${esc(u.username)}"></i></td></tr>`).join('');
    openModal(`<div class="modal wide"><h3><i class="ti ti-users-group"></i> Gestione utenti</h3>
      <div style="text-align:right;margin-bottom:8px"><button class="btn btn-primary" id="u_new"><i class="ti ti-user-plus"></i> Nuovo utente</button></div>
      <table class="utable"><thead><tr><th>Utente</th><th>Ruolo</th><th>Permessi</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    $('#u_new', modalBg).onclick = () => userForm();
    modalBg.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`Eliminare l'utente "${b.dataset.del}"?`)) return;
      const r = await apiPost('user_delete', { username: b.dataset.del });
      if (r.ok) { toast('Utente eliminato'); usersPanel(); } else toast(r.error || 'Errore', true);
    });
    modalBg.querySelectorAll('[data-u]').forEach(b => b.onclick = () =>
      userForm({ username: b.dataset.u, role: b.dataset.r, permission: b.dataset.p }));
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
      };
      if (editing) data.original = u.username;
      const r = await apiPost('user_save', data);
      if (r.ok) { toast('Utente salvato'); usersPanel(); } else toast(r.error || 'Errore', true);
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
    openModal(`<div class="modal"><h3><i class="ti ti-share"></i> Condividi "${esc(name)}"</h3>
      <label>Durata del link</label>
      <select id="sh_ttl">
        <option value="3600">1 ora</option>
        <option value="86400" selected>24 ore</option>
        <option value="604800">7 giorni</option>
        <option value="2592000">30 giorni</option>
      </select>
      <div id="sh_result" style="margin-top:12px"></div>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button>
        <button class="btn btn-primary" id="sh_create"><i class="ti ti-link"></i> Crea link</button></div></div>`);
    $('#sh_create', modalBg).onclick = async () => {
      const ttl = $('#sh_ttl', modalBg).value;
      const r = await apiPost('share_create', { path: rel, ttl });
      if (!r.ok) { toast(r.error || 'Errore', true); return; }
      const when = new Date(r.expires_at * 1000).toLocaleString('it-IT');
      $('#sh_result', modalBg).innerHTML = `<label>Link pubblico — scade il ${esc(when)}</label>
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
        <td><i class="ti ${s.type === 'dir' ? 'ti-folder' : 'ti-file'}"></i> ${esc(s.name)}${r.is_admin ? ` <span class="muted" style="font-size:11px">(${esc(s.created_by)})</span>` : ''}</td>
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

  // ─── Wiring toolbar ────────────────────────────────────────────────────
  if (CAN_WRITE) {
    $('#btnUpload').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { uploadItems(Array.from(e.target.files).map(f => ({ file: f, rel: '' }))); e.target.value = ''; };
    $('#btnUploadFolder') && ($('#btnUploadFolder').onclick = () => $('#folderInput').click());
    $('#folderInput') && ($('#folderInput').onchange = e => { uploadItems(Array.from(e.target.files).map(f => ({ file: f, rel: relDir(f.webkitRelativePath) }))); e.target.value = ''; });
    $('#btnNewFolder').onclick = newFolderDialog;
    $('#btnNewFile').onclick = newFileDialog;
    $('#btnDelSel') && ($('#btnDelSel').onclick = () => deleteDialog([...selected]));
  }
  $('#btnRefresh').onclick = () => load(cwd);
  $('#btnShares') && ($('#btnShares').onclick = sharesPanel);
  $('#btnZipCurrent').onclick = () => downloadZip(selected.size ? [...selected] : [cwd || '']);
  $('#btnZipSel').onclick = () => downloadZip([...selected]);
  if (IS_ADMIN) $('#btnUsers').onclick = usersPanel;
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
