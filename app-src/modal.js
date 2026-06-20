// modal.js — dialog generico, anti doppio-submit e prompt riusabile.
import { S, $, modalBg } from './state.js';
import { esc, toast } from './util.js';
import { load } from './listing.js';

export function openModal(html) {
  modalBg.innerHTML = html; modalBg.hidden = false;
  modalBg.onclick = e => { if (e.target === modalBg) closeModal(); };
  const first = modalBg.querySelector('input,textarea,select'); if (first) first.focus();
}
export function closeModal() {
  if (S.shareTimer) { clearInterval(S.shareTimer); S.shareTimer = null; }
  if (S.editorCleanup) { try { S.editorCleanup(); } catch (_) {} S.editorCleanup = null; }
  modalBg.hidden = true; modalBg.innerHTML = '';
}
// L'HTML dei dialog usa onclick="closeModal()" → serve come globale.
window.closeModal = closeModal;

// Esegue un submit asincrono UNA sola volta (anti doppio-click / Enter+click):
// ignora le invocazioni mentre una è in corso e disabilita il bottone.
export function guardSubmit(btn, fn) {
  let busy = false;
  return async (...a) => {
    if (busy) return;
    busy = true; if (btn) btn.disabled = true;
    try { return await fn(...a); }
    finally { busy = false; if (btn) btn.disabled = false; }
  };
}

export function promptDialog(title, icon, label, placeholder, onok, okText = 'Crea') {
  openModal(`<div class="modal"><h3><i class="ti ${icon}"></i> ${esc(title)}</h3>
    <label>${esc(label)}</label><input type="text" id="m_input" placeholder="${esc(placeholder)}">
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="m_ok">${esc(okText)}</button></div></div>`);
  const input = $('#m_input', modalBg);
  const go = guardSubmit($('#m_ok', modalBg), async () => {
    const val = input.value.trim(); if (!val) return;
    const res = await onok(val);
    if (res && res.ok) { closeModal(); load(S.cwd); } else toast(res && res.error || 'Errore', true);
  });
  $('#m_ok', modalBg).onclick = go;
  input.onkeydown = e => { if (e.key === 'Enter') go(); };
}
