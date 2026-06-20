// main.js — entry point: cabla la toolbar, il drag&drop e avvia il primo load.
// esbuild parte da QUI e segue gli import per costruire il bundle (assets/app.js).
import { CAN_WRITE, IS_ADMIN, S, selected, $, searchEl, modalBg } from './state.js';
import { toast } from './util.js';
import { load, renderRows, updateSelbar } from './listing.js';
import { startZip } from './zip.js';
import { sharesPanel } from './shares.js';
import { adminPanel } from './admin.js';
import { newFolderDialog, newFileDialog, newNoteDialog, deleteDialog } from './dialogs.js';
import { uploadItems, walkEntry, relDir } from './upload.js';
import { closeModal } from './modal.js';

// Mostra a video qualunque errore JS imprevisto (diagnosi, invece di pagina "morta")
window.addEventListener('error', e => { try { toast('Errore: ' + (e.message || (e.error && e.error.message) || e), true); } catch (_) {} });
window.addEventListener('unhandledrejection', e => { try { toast('Errore: ' + ((e.reason && e.reason.message) || e.reason), true); } catch (_) {} });

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
$('#btnRefresh').onclick = () => load(S.cwd);
$('#btnShares') && ($('#btnShares').onclick = sharesPanel);
$('#btnZipCurrent').onclick = () => startZip(selected.size ? [...selected] : [S.cwd || '']);
$('#btnZipSel').onclick = () => startZip([...selected]);
if (IS_ADMIN) $('#btnAdmin') && ($('#btnAdmin').onclick = () => adminPanel('users'));
searchEl.oninput = renderRows;
$('#checkAll').onchange = e => {
  const filter = searchEl.value.trim().toLowerCase();
  S.items.filter(it => !filter || it.name.toLowerCase().includes(filter))
    .forEach(it => { const rel = (S.cwd ? S.cwd + '/' : '') + it.name; e.target.checked ? selected.add(rel) : selected.delete(rel); });
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

load('');
