// dialogs.js — dialog di creazione/rinomina/eliminazione e "Nuova nota".
import { S, $, modalBg } from './state.js';
import { apiPost } from './net.js';
import { toast, esc } from './util.js';
import { openModal, closeModal, guardSubmit, promptDialog } from './modal.js';
import { load } from './listing.js';
import { openEditor } from './editor.js';

export function newFolderDialog() {
  promptDialog('Nuova cartella', 'ti-folder-plus', 'Nome cartella', 'es. documenti',
    name => apiPost('mkdir', { path: S.cwd, name }));
}
export function newFileDialog() {
  openModal(`<div class="modal"><h3><i class="ti ti-file-plus"></i> Nuovo file</h3>
    <label>Nome file</label><input type="text" id="f_name" placeholder="es. note.txt">
    <label>Contenuto (opzionale)</label><textarea id="f_body"></textarea>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="f_ok">Crea</button></div></div>`);
  $('#f_ok', modalBg).onclick = guardSubmit($('#f_ok', modalBg), async () => {
    const name = $('#f_name', modalBg).value.trim(); if (!name) return;
    const res = await apiPost('newfile', { path: S.cwd, name, content: $('#f_body', modalBg).value });
    if (res.ok) { closeModal(); load(S.cwd); } else toast(res.error || 'Errore', true);
  });
}
export function renameDialog(oldName, rel) {
  promptDialog('Rinomina', 'ti-pencil', 'Nuovo nome', oldName,
    name => apiPost('rename', { from: rel, to: name }), 'Rinomina');
  const input = $('#m_input', modalBg); input.value = oldName; input.select();
}
export function deleteDialog(paths, label) {
  const what = paths.length === 1 ? `"${esc(label || paths[0])}"` : `${paths.length} elementi`;
  openModal(`<div class="modal"><div class="center"><div class="warn-ico"><i class="ti ti-alert-triangle"></i></div>
    <h3 style="justify-content:center">Eliminare ${what}?</h3>
    <p class="muted">L'operazione è definitiva e non reversibile.</p></div>
    <div class="modal-actions" style="justify-content:center">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-danger" id="d_ok"><i class="ti ti-trash"></i> Elimina</button></div></div>`);
  $('#d_ok', modalBg).onclick = async () => {
    const res = await apiPost('delete', { paths });
    if (res.ok) { closeModal(); toast(`Eliminati: ${res.deleted}`); load(S.cwd); }
    else toast(res.error || 'Errore', true);
  };
}

export function newNoteDialog() {
  openModal(`<div class="modal"><h3><i class="ti ti-note"></i> Nuova nota</h3>
    <label>Nome nota</label><input type="text" id="nn_name" placeholder="es. appunti.md">
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="nn_ok"><i class="ti ti-edit"></i> Crea e apri</button></div></div>`);
  const go = guardSubmit($('#nn_ok', modalBg), async () => {
    let name = $('#nn_name', modalBg).value.trim(); if (!name) return;
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
    const r = await apiPost('newfile', { path: S.cwd, name, content: '' });
    const rel = (S.cwd ? S.cwd + '/' : '') + name;
    // creata, OPPURE esiste già → in entrambi i casi apri la nota ("Crea e apri")
    if (r.ok || /esiste già/i.test(r.error || '')) { closeModal(); load(S.cwd); openEditor(rel, name); }
    else toast(r.error || 'Errore', true);
  });
  $('#nn_ok', modalBg).onclick = go;
  $('#nn_name', modalBg).onkeydown = e => { if (e.key === 'Enter') go(); };
}
