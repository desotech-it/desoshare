// editor.js — editor di note collaborativo (bundle CodeMirror/Yjs) con fallback semplice.
import { S, modalBg, $, EDITOR_BUNDLE_V } from './state.js';
import { apiGet, apiPost } from './net.js';
import { esc, b64ToU8 } from './util.js';
import { openModal, closeModal } from './modal.js';

export async function openEditor(rel, name) {
  if (S.editorCleanup) closeModal();
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
  try { E = await window.NoteEditor.loadBundle('assets/editor-bundle.js?v=' + EDITOR_BUNDLE_V); } catch (e) { E = null; }
  if (E) {
    S.editorCleanup = window.NoteEditor.mount({
      host, statusEl, presEl, info,
      sync: payload => apiPost('note_sync', Object.assign({ path: rel }, payload)),
      save: content => apiPost('note_save', { path: rel, content }),
    });
  } else {
    editorFallback(rel, info, host, statusEl);
  }
}

// Fallback: se il bundle non si carica, editor semplice (singolo utente, niente real-time)
export function editorFallback(rel, info, host, statusEl) {
  statusEl.textContent = info.editable ? 'editor semplice' : 'sola lettura';
  const text = info.text ? new TextDecoder().decode(b64ToU8(info.text)) : '';
  host.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.value = text; ta.readOnly = !info.editable;
  ta.style.cssText = 'width:100%;height:100%;border:0;outline:none;resize:none;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:10px;box-sizing:border-box';
  host.appendChild(ta);
  let t = null, dirty = false;
  if (info.editable) ta.oninput = () => { dirty = true; clearTimeout(t); t = setTimeout(async () => { if (!dirty) return; dirty = false; const r = await apiPost('note_save', { path: rel, content: ta.value }); statusEl.textContent = r.ok ? 'salvato' : 'errore salvataggio'; }, 1500); };
  S.editorCleanup = () => { clearTimeout(t); };
}
