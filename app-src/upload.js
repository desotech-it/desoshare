// upload.js — upload a chunk, parallelo + ripresa (file e cartelle, drag&drop).
import { S, CSRF, CAN_WRITE, $, modalBg } from './state.js';
import { apiPost } from './net.js';
import { esc, fmtBytes } from './util.js';
import { openModal, closeModal } from './modal.js';
import { load } from './listing.js';

const CHUNK = 16 * 1024 * 1024;   // 16 MB per blocco
const CONC = 3;                   // blocchi in parallelo per file
const MAX_RETRY = 5;

export function relDir(p) { if (!p) return ''; const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

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
export function uploadItems(items) {
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
    closeBtn.onclick = () => { closeModal(); load(S.cwd); };
    load(S.cwd);
  })();
}

async function uploadOne(r) {
  const f = r.it.file;
  const dir = [S.cwd, r.it.rel].filter(Boolean).join('/');
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
export function walkEntry(entry, parentPath) {
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
