// shares.js — link nominativi a scadenza: dialog di creazione e pannello dei link attivi.
import { S, modalBg, $, CAN_WRITE } from './state.js';
import { apiGet, apiPost } from './net.js';
import { toast, esc, isTextFile, copyText, fmtDuration, fmtBytes, slugify, iconFor } from './util.js';
import { openModal, guardSubmit } from './modal.js';
import { trashPanel } from './trash.js';
import { shareAccessPanel } from './accesslog.js';

// Livelli d'accesso [valore, nome, spiegazione]. Per una nota `edit` è il co-editing.
const DIR_LEVELS = [
  ['view', 'Sola lettura', 'Vede e scarica i file. Non può modificare nulla.'],
  ['edit', 'Caricamento', 'Può anche caricare file. Non sovrascrive niente: un nome già presente diventa «nome (2)».'],
  ['contrib', 'Collaboratore', 'Carica file e crea cartelle. Sostituisce, rinomina ed elimina solo ciò che ha caricato con questo link; ciò che elimina o sostituisce finisce nel tuo cestino.'],
  ['manage', 'Gestione completa', 'Carica, sovrascrive, rinomina ed elimina tutto nella cartella. Ciò che elimina o sostituisce finisce nel tuo cestino. Meglio con un PIN.'],
];
const NOTE_LEVELS = [
  ['view', 'Sola lettura', 'Legge e scarica la nota.'],
  ['edit', 'Modificabile (co-editing)', 'Modifica la nota insieme a te, in tempo reale.'],
];
const UPLOAD_LEVELS = new Set(['edit', 'contrib', 'manage']);   // livelli di cartella che caricano file

function levelName(mode, isDir) {
  const l = (isDir ? DIR_LEVELS : NOTE_LEVELS).find(x => x[0] === mode);
  return l ? l[1].replace(/ \(co-editing\)$/, '') : 'Sola lettura';
}

// Parte leggibile come la produce share_slug_make(): slug troncato a 42 caratteri
// (42 + 22 di «-AAAAMMGG-HHMM-codice» ≤ 64), «link» se resta vuota.
const READABLE_MAX = 42;
const readablePart = v => slugify(v).slice(0, READABLE_MAX).replace(/-+$/, '') || 'link';

// Data e ora come le scrive il server nell'indirizzo (fuso di Roma, SHARE_SLUG_TZ).
function slugStamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  try {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
    if (p.year && p.minute) return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
  } catch (_) { /* fuso non supportato: ora locale */ }
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const LIMIT_OPTS = `<option value="100">100 MB</option>
      <option value="500">500 MB</option>
      <option value="1024" selected>1 GB</option>
      <option value="5120">5 GB</option>
      <option value="0">Nessun tetto (solo la mia quota)</option>`;

export function shareDialog(rel, name, isDir = false) {
  // Livelli ≠ sola lettura: cartelle e note, e solo per chi ha la scrittura (il server darebbe 403).
  const levels = !CAN_WRITE ? null : isDir ? DIR_LEVELS : isTextFile(name) ? NOTE_LEVELS : null;
  const defName = isDir ? name : name.replace(/\.[^.]+$/, '');   // file: senza estensione (come il server)
  const defSlug = slugify(defName);
  const base = location.origin + location.pathname.replace(/\/[^/]*$/, '');
  const access = levels
    ? `<label for="sh_mode">Accesso</label>
    <select id="sh_mode">${levels.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select>
    <div id="sh_mode_help" class="sh-help"></div>
    ${isDir ? `<div id="sh_limit_wrap" hidden><label for="sh_limit">Spazio caricabile tramite il link <span class="sh-opt">(oltre vale la tua quota)</span></label>
    <select id="sh_limit">${LIMIT_OPTS}</select></div>` : ''}`
    : `<label>Accesso</label><div class="sh-fixed"><i class="ti ti-eye"></i> Sola lettura
      <span class="muted">— ${isDir ? 'vede e scarica i file' : 'può scaricare il file'}</span></div>`;
  openModal(`<div class="modal sh-modal"><h3><i class="ti ti-share"></i> Condividi "${esc(name)}"</h3>
    <label for="sh_label">A chi lo dai <span class="sh-opt">(facoltativo)</span></label>
    <input type="text" id="sh_label" maxlength="80" placeholder="es. Avv. Bianchi" autocomplete="off">
    <label for="sh_ttl">Durata del link</label>
    <select id="sh_ttl">
      <option value="3600">1 ora</option>
      <option value="86400" selected>24 ore</option>
      <option value="604800">7 giorni</option>
      <option value="2592000">30 giorni</option>
    </select>
    ${access}
    <label for="sh_pin">PIN <span class="sh-opt">(facoltativo, da 4 a 64 caratteri)</span></label>
    <input type="text" id="sh_pin" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="sh-help">Comunicalo a parte (telefono, messaggio). Senza PIN basta il link.</div>
    <label for="sh_slug">Indirizzo del link</label>
    <div class="sh-slug"><span class="muted">/d/</span>
      <input type="text" id="sh_slug" value="${esc(defSlug)}" placeholder="${esc(readablePart(defName))}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div id="sh_slughint" class="sh-preview"></div>
    <div class="sh-help">Data, ora e codice casuale vengono aggiunti automaticamente: ogni link è unico e non si indovina.</div>
    <div id="sh_err" class="sh-err" hidden></div>
    <div id="sh_result"></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button>
      <button class="btn btn-primary" id="sh_create"><i class="ti ti-link"></i> Crea link</button></div></div>`);
  const slugEl = $('#sh_slug', modalBg), hintEl = $('#sh_slughint', modalBg), errEl = $('#sh_err', modalBg);
  const modeEl = $('#sh_mode', modalBg);
  const showErr = msg => { errEl.textContent = msg; errEl.hidden = !msg; };
  // Campo vuoto = il server usa il nome dell'elemento: l'anteprima fa lo stesso.
  const updHint = () => {
    const r = readablePart(slugEl.value.trim() === '' ? defName : slugEl.value);
    hintEl.textContent = '→ ' + base + '/d/' + r + '-' + slugStamp() + '-xxxxxx';
  };
  slugEl.oninput = updHint; updHint();
  const curMode = () => (modeEl ? modeEl.value : 'view');
  const hasCap = () => isDir && UPLOAD_LEVELS.has(curMode());   // il tetto vale solo se il link carica file
  if (modeEl) {
    const helpEl = $('#sh_mode_help', modalBg), limWrap = $('#sh_limit_wrap', modalBg);
    modeEl.onchange = () => {
      helpEl.textContent = (levels.find(l => l[0] === modeEl.value) || levels[0])[2];
      if (limWrap) limWrap.hidden = !hasCap();
    };
    modeEl.onchange();
  }
  // guardSubmit: un doppio click creerebbe due link.
  $('#sh_create', modalBg).onclick = guardSubmit($('#sh_create', modalBg), async () => {
    showErr('');
    const mode = curMode();
    const label = $('#sh_label', modalBg).value.trim();
    const pinEl = $('#sh_pin', modalBg);
    // Spazi ai bordi di un PIN incollato lo renderebbero impossibile da digitare: via.
    const pin = pinEl.value.trim(); pinEl.value = pin;
    if (pin && [...pin].length < 4) { showErr('Il PIN deve avere almeno 4 caratteri (oppure lascialo vuoto).'); pinEl.focus(); return; }
    const limitMb = hasCap() ? $('#sh_limit', modalBg).value : '';
    const r = await apiPost('share_create', { path: rel, ttl: $('#sh_ttl', modalBg).value, mode, slug: slugEl.value.trim(),
      label, pin, upload_limit_mb: limitMb });
    if (!r || !r.ok) { showErr((r && r.error) || 'Errore nella creazione del link'); return; }
    const rMode = r.mode || mode, rLabel = r.label != null ? r.label : label;
    const when = new Date(r.expires_at * 1000).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
    const cap = hasCap() ? (Number(limitMb) > 0 ? ` · fino a ${fmtBytes(Number(limitMb) * 1048576)}` : ' · nessun tetto') : '';
    $('#sh_result', modalBg).innerHTML = `<div class="sh-done">
      <label for="sh_url">Link creato</label>
      <div class="sh-url"><input type="text" id="sh_url" readonly value="${esc(r.url)}">
        <button class="btn" id="sh_copy" title="Copia link"><i class="ti ti-copy"></i></button></div>
      <dl class="sh-sum">
        <dt>Livello</dt><dd>${esc(levelName(rMode, isDir) + cap)}</dd>
        ${rLabel ? `<dt>Destinatario</dt><dd>${esc(rLabel)}</dd>` : ''}
        <dt>Scade</dt><dd>${esc(when)}</dd>
      </dl>
      ${r.has_pin ? '<div class="sh-pinset"><i class="ti ti-lock"></i> PIN impostato: comunicalo separatamente</div>' : ''}</div>`;
    // Link creato: il dialog resta come riepilogo (un altro clic darebbe un secondo link).
    modalBg.querySelectorAll('#sh_label, #sh_ttl, #sh_mode, #sh_limit, #sh_pin, #sh_slug').forEach(el => { el.disabled = true; });
    $('#sh_create', modalBg).remove();
    modalBg.querySelector('.modal-actions .btn').classList.add('btn-primary');
    const inp = $('#sh_url', modalBg); inp.focus(); inp.select();
    $('#sh_copy', modalBg).onclick = () => { copyText(r.url); toast('Link copiato'); };
  });
}

// Riga secondaria di un link: destinatario, livello (effettivo), PIN, spazio usato.
function shareMeta(s, isAdmin) {
  const isDir = s.type === 'dir';
  const mode = s.mode || 'view', level = s.level || mode;
  const parts = [];
  if (s.label) parts.push(`per «${esc(s.label)}»`);
  parts.push(level === mode ? esc(levelName(level, isDir))
    : `${esc(levelName(level, isDir))} <span title="Chi l'ha creato non ha più il permesso di scrittura">(era ${esc(levelName(mode, isDir))})</span>`);
  if (s.has_pin) parts.push('<i class="ti ti-lock" title="Protetto da PIN" aria-label="Protetto da PIN"></i>');
  if (isDir && UPLOAD_LEVELS.has(mode)) {
    const used = Number(s.uploaded) || 0, cap = Number(s.upload_limit) || 0;
    parts.push(esc('caricati ' + fmtBytes(used) + (cap > 0 ? ' / ' + fmtBytes(cap) : ' (nessun tetto)')));
  }
  if (isAdmin && s.created_by) parts.push('di ' + esc(s.created_by));
  return parts.join(' · ');
}

export async function sharesPanel() {
  // Il conteggio del cestino è accessorio: se fallisce il pannello si apre lo stesso.
  const [r, t] = await Promise.all([apiGet('share_list'), apiGet('trash_list').catch(() => null)]);
  if (!r.ok) { toast(r.error || 'Errore', true); return; }
  const nTrash = t && t.ok && Array.isArray(t.entries) ? t.entries.length : null;
  const body = r.shares.length ? `<div class="sh-scroll"><table class="utable sh-table"><thead><tr><th>Elemento</th><th>Scade</th><th></th></tr></thead><tbody>${
    r.shares.map(s => `<tr data-exp="${Number(s.expires_at) || 0}">
      <td><div class="sh-name"><i class="ti ${iconFor({ type: s.type === 'dir' ? 'dir' : 'file', name: String(s.name || '') })}"></i> ${esc(s.name)}</div>
        <div class="sh-meta">${shareMeta(s, r.is_admin)}</div></td>
      <td class="sh-rem" style="white-space:nowrap"></td>
      <td class="uact" style="white-space:nowrap">
        <i class="ti ti-activity" data-acc="${esc(s.token)}" title="Accessi"></i>
        <i class="ti ti-key" data-pin="${esc(s.token)}" title="${s.has_pin ? 'Cambia o togli il PIN' : 'Imposta un PIN'}"></i>
        <i class="ti ti-clock-edit" data-ttl="${esc(s.token)}" title="Cambia scadenza"></i>
        <i class="ti ti-copy" data-url="${esc(s.url)}" title="Copia link"></i>
        <i class="ti ti-trash" data-revoke="${esc(s.token)}" title="Revoca"></i></td></tr>`).join('')
    }</tbody></table></div>` : '<p class="muted">Nessuna condivisione attiva.</p>';
  openModal(`<div class="modal wide sh-panel"><h3><i class="ti ti-share"></i> Condivisioni attive</h3>${body}
    <div class="modal-actions"><button class="btn sh-trash-btn" id="sh_trash"><i class="ti ti-trash"></i> Cestino${nTrash !== null ? ` (${nTrash})` : ''}</button>
      <button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
  $('#sh_trash', modalBg).onclick = () => trashPanel();
  modalBg.querySelectorAll('[data-url]').forEach(b => b.onclick = () => { copyText(b.dataset.url); toast('Link copiato'); });
  modalBg.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
    const s = r.shares.find(x => x.token === b.dataset.revoke) || {};
    const who = s.label ? ` di «${s.label}»` : '';
    if (!confirm(`Revocare il link${who} a «${s.name || ''}»? Smetterà subito di funzionare.`)) return;
    const x = await apiPost('share_revoke', { token: b.dataset.revoke });
    if (x.ok) { toast('Condivisione revocata'); sharesPanel(); } else toast(x.error || 'Errore', true);
  });
  modalBg.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => {
    const s = r.shares.find(x => x.token === b.dataset.acc);
    if (s) { if (S.shareTimer) { clearInterval(S.shareTimer); S.shareTimer = null; } shareAccessPanel(s, sharesPanel); }
  });
  // PIN: imposta, cambia o togli. Cambiarlo obbliga chi l'aveva già sbloccato a reinserirlo.
  modalBg.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => {
    const s = r.shares.find(x => x.token === b.dataset.pin);
    const td = b.closest('tr').querySelector('td');
    if (!s || td.querySelector('.sh-pin-edit')) return;
    const box = document.createElement('div');
    box.className = 'sh-pin-edit';
    box.innerHTML = `<input type="text" autocomplete="off" placeholder="${s.has_pin ? 'Nuovo PIN' : 'PIN (4–64 caratteri)'}" maxlength="64">
      <button class="btn btn-primary" data-act="set">${s.has_pin ? 'Cambia PIN' : 'Imposta PIN'}</button>
      ${s.has_pin ? '<button class="btn" data-act="remove">Togli PIN</button>' : ''}<button class="btn" data-act="cancel">Annulla</button>
      <span class="muted sh-pin-note">Comunicalo a parte. Chi aveva già inserito il vecchio PIN dovrà inserire quello nuovo.</span>`;
    td.appendChild(box);
    const inp = box.querySelector('input'); inp.focus();
    const send = async (data, msg) => {
      box.querySelectorAll('button').forEach(x => { x.disabled = true; });
      const x = await apiPost('share_update', { token: s.token, ...data });
      if (x.ok) { toast(msg); sharesPanel(); }
      else { toast(x.error || 'Errore', true); box.querySelectorAll('button').forEach(y => { y.disabled = false; }); }
    };
    box.querySelector('[data-act="set"]').onclick = () => {
      const v = inp.value;
      if (v.length < 4) { toast('Il PIN deve avere almeno 4 caratteri', true); inp.focus(); return; }
      send({ pin_action: 'set', pin: v }, s.has_pin ? 'PIN cambiato' : 'PIN impostato');
    };
    inp.onkeydown = e => { if (e.key === 'Enter') box.querySelector('[data-act="set"]').onclick(); };
    const rm = box.querySelector('[data-act="remove"]');
    if (rm) rm.onclick = () => { if (confirm('Togliere il PIN? Basterà l\'indirizzo per aprire il link.')) send({ pin_action: 'remove' }, 'PIN tolto'); };
    box.querySelector('[data-act="cancel"]').onclick = () => box.remove();
  });
  // Nuova scadenza: la cella «Scade» diventa una scelta di durata (da adesso).
  modalBg.querySelectorAll('[data-ttl]').forEach(b => b.onclick = () => {
    const tr = b.closest('tr'); const cell = tr.querySelector('.sh-rem');
    if (tr.dataset.editing) return;
    tr.dataset.editing = '1';
    cell.innerHTML = `<select class="sh-ttl"><option value="">Scade da adesso tra…</option><option value="3600">1 ora</option><option value="86400">24 ore</option><option value="604800">7 giorni</option><option value="2592000">30 giorni</option></select>`;
    const sel = cell.querySelector('select'); sel.focus();
    sel.onchange = async () => {
      if (!sel.value) return;
      sel.disabled = true;
      const x = await apiPost('share_update', { token: b.dataset.ttl, ttl: sel.value });
      if (x.ok) { toast('Scadenza aggiornata'); sharesPanel(); }
      else { toast(x.error || 'Errore', true); delete tr.dataset.editing; sel.disabled = false; }
    };
  });
  if (S.shareTimer) clearInterval(S.shareTimer);
  // Il countdown usa l'orologio del SERVER (r.now) ancorato al caricamento: con
  // il clock del client avanti le share sparivano dal pannello pur essendo valide.
  const skew = (typeof r.now === 'number' ? r.now : Date.now() / 1000) - Date.now() / 1000;
  const tick = () => {
    modalBg.querySelectorAll('tr[data-exp]').forEach(tr => {
      const rem = tr.dataset.exp - (Date.now() / 1000 + skew);
      const cell = tr.querySelector('.sh-rem');
      if (rem <= 0) tr.remove(); else if (cell && !tr.dataset.editing) cell.textContent = 'tra ' + fmtDuration(rem);
    });
  };
  tick(); S.shareTimer = setInterval(tick, 1000);
}
