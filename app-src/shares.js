// shares.js — condivisioni a scadenza: dialog di creazione e pannello attive.
import { S, modalBg, $ } from './state.js';
import { apiGet, apiPost } from './net.js';
import { toast, esc, isTextFile, copyText, fmtDuration } from './util.js';
import { openModal } from './modal.js';

export function shareDialog(rel, name) {
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
export async function sharesPanel() {
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
  if (S.shareTimer) clearInterval(S.shareTimer);
  const tick = () => {
    modalBg.querySelectorAll('tr[data-exp]').forEach(tr => {
      const rem = tr.dataset.exp - Date.now() / 1000;
      const cell = tr.querySelector('.sh-rem');
      if (rem <= 0) tr.remove(); else if (cell) cell.textContent = 'tra ' + fmtDuration(rem);
    });
  };
  tick(); S.shareTimer = setInterval(tick, 1000);
}
