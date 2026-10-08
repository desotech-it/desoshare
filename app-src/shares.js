// shares.js — condivisioni a scadenza: dialog di creazione e pannello attive.
import { S, modalBg, $ } from './state.js';
import { apiGet, apiPost } from './net.js';
import { toast, esc, isTextFile, copyText, fmtDuration, fmtBytes, slugify } from './util.js';
import { openModal, guardSubmit } from './modal.js';

export function shareDialog(rel, name, isDir = false) {
  // Modificabile: nota → co-editing; cartella → chi ha il link può caricare file.
  const canEdit = isDir || isTextFile(name);
  const defSlug = slugify(name.replace(/\.[^.]+$/, ''));          // nome senza estensione → slug
  const base = location.origin + location.pathname.replace(/\/[^/]*$/, '');
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
      <option value="edit">${isDir ? 'Modificabile (chiunque abbia il link può caricare file nella cartella)' : 'Modificabile (chiunque abbia il link co-edita)'}</option>
    </select>
    ${isDir ? `<div id="sh_limit_wrap" style="display:none"><label style="margin-top:10px">Spazio caricabile tramite il link <span class="muted" style="font-weight:400">(oltre vale la tua quota)</span></label>
    <select id="sh_limit">
      <option value="100">100 MB</option>
      <option value="500">500 MB</option>
      <option value="1024" selected>1 GB</option>
      <option value="5120">5 GB</option>
      <option value="0">Nessun tetto (solo la mia quota)</option>
    </select></div>` : ''}` : ''}
    <label style="margin-top:10px">Indirizzo del link <span class="muted" style="font-weight:400">(facoltativo)</span></label>
    <div style="display:flex;align-items:center;gap:3px;font-size:13px">
      <span class="muted" style="white-space:nowrap">/d/</span>
      <input type="text" id="sh_slug" placeholder="link-casuale" value="${esc(defSlug)}" style="flex:1" autocomplete="off">
    </div>
    <span id="sh_slughint" class="muted" style="font-size:11px"></span>
    <div id="sh_result" style="margin-top:12px"></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button>
      <button class="btn btn-primary" id="sh_create"><i class="ti ti-link"></i> Crea link</button></div></div>`);
  const slugEl = $('#sh_slug', modalBg), hintEl = $('#sh_slughint', modalBg);
  const updHint = () => {
    hintEl.style.color = '';
    const sl = slugify(slugEl.value);
    hintEl.textContent = sl ? '→ ' + base + '/d/' + sl : 'Vuoto = link casuale non indovinabile.';
  };
  slugEl.oninput = updHint; updHint();
  // Il tetto di caricamento ha senso solo per una cartella modificabile.
  if (isDir) {
    const modeEl = $('#sh_mode', modalBg), limWrap = $('#sh_limit_wrap', modalBg);
    modeEl.onchange = () => { limWrap.style.display = modeEl.value === 'edit' ? '' : 'none'; };
  }
  // guardSubmit: un doppio click creerebbe due condivisioni (o un 409 spurio con slug)
  $('#sh_create', modalBg).onclick = guardSubmit($('#sh_create', modalBg), async () => {
    const ttl = $('#sh_ttl', modalBg).value;
    const mode = canEdit ? $('#sh_mode', modalBg).value : 'view';
    const limitMb = isDir && mode === 'edit' ? $('#sh_limit', modalBg).value : '';
    const r = await apiPost('share_create', { path: rel, ttl, mode, slug: slugEl.value, upload_limit_mb: limitMb });
    if (!r.ok) { hintEl.textContent = r.error || 'Errore'; hintEl.style.color = 'var(--danger, #c0392b)'; return; }
    const when = new Date(r.expires_at * 1000).toLocaleString('it-IT');
    const cap = isDir && mode === 'edit' ? (Number(limitMb) > 0 ? `, fino a ${fmtBytes(Number(limitMb) * 1048576)}` : ', nessun tetto') : '';
    $('#sh_result', modalBg).innerHTML = `<label>Link pubblico (${mode === 'edit' ? 'modificabile' + cap : 'sola lettura'}) — scade il ${esc(when)}</label>
      <div style="display:flex;gap:6px"><input type="text" id="sh_url" readonly value="${esc(r.url)}" style="flex:1">
      <button class="btn" id="sh_copy" title="Copia"><i class="ti ti-copy"></i></button></div>`;
    // Link creato: il dialog resta come riepilogo (un altro clic darebbe 409 o un secondo link).
    modalBg.querySelectorAll('#sh_ttl, #sh_mode, #sh_limit, #sh_slug').forEach(el => { el.disabled = true; });
    $('#sh_create', modalBg).remove();
    modalBg.querySelector('.modal-actions .btn').classList.add('btn-primary');
    const inp = $('#sh_url', modalBg); inp.focus(); inp.select();
    $('#sh_copy', modalBg).onclick = () => { copyText(r.url); toast('Link copiato'); };
  });
}
export async function sharesPanel() {
  const r = await apiGet('share_list');
  if (!r.ok) { toast(r.error || 'Errore', true); return; }
  const body = r.shares.length ? `<table class="utable"><thead><tr><th>Elemento</th><th>Scade</th><th></th></tr></thead><tbody>${
    r.shares.map(s => `<tr data-exp="${s.expires_at}">
      <td><i class="ti ${s.type === 'dir' ? 'ti-folder' : 'ti-file'}"></i> ${esc(s.name)}${s.mode === 'edit' ? ` <span class="muted" style="font-size:11px">· modificabile${s.type === 'dir' ? ' · caricati ' + fmtBytes(s.uploaded || 0) + (s.upload_limit > 0 ? ' / ' + fmtBytes(s.upload_limit) : '') : ''}</span>` : ''}${r.is_admin ? ` <span class="muted" style="font-size:11px">(${esc(s.created_by)})</span>` : ''}</td>
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
  if (S.shareTimer) clearInterval(S.shareTimer);
  // Il countdown usa l'orologio del SERVER (r.now) ancorato al caricamento: con
  // il clock del client avanti le share sparivano dal pannello pur essendo valide.
  const skew = (typeof r.now === 'number' ? r.now : Date.now() / 1000) - Date.now() / 1000;
  const tick = () => {
    modalBg.querySelectorAll('tr[data-exp]').forEach(tr => {
      const rem = tr.dataset.exp - (Date.now() / 1000 + skew);
      const cell = tr.querySelector('.sh-rem');
      if (rem <= 0) tr.remove(); else if (cell) cell.textContent = 'tra ' + fmtDuration(rem);
    });
  };
  tick(); S.shareTimer = setInterval(tick, 1000);
}
