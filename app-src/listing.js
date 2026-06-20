// listing.js — caricamento cartella e rendering di briciole, righe e selezione.
import { S, selected, rowsEl, emptyEl, crumbsEl, selbar, selCount, searchEl, CAN_WRITE, $ } from './state.js';
import { apiGet } from './net.js';
import { toast, esc, iconFor, isTextFile } from './util.js';
import { startZip } from './zip.js';
import { openEditor } from './editor.js';
import { shareDialog } from './shares.js';
import { renameDialog, deleteDialog } from './dialogs.js';

export async function load(path = '') {
  const res = await apiGet('list', { path });
  if (!res.ok) { toast(res.error || 'Errore', true); return; }
  S.cwd = res.path === '/' ? '' : res.path.replace(/^\//, '');
  S.items = res.items;
  selected.clear();
  renderCrumbs(); renderRows(); updateSelbar();
}

export function renderCrumbs() {
  const parts = S.cwd ? S.cwd.split('/') : [];
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

export function renderRows() {
  const filter = searchEl.value.trim().toLowerCase();
  const shown = S.items.filter(it => !filter || it.name.toLowerCase().includes(filter));
  rowsEl.innerHTML = '';
  emptyEl.hidden = shown.length > 0;
  for (const it of shown) {
    const rel = (S.cwd ? S.cwd + '/' : '') + it.name;
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
  $('#checkAll').checked = shown.length > 0 && shown.every(it => selected.has((S.cwd ? S.cwd + '/' : '') + it.name));
}

export function updateSelbar() {
  selbar.hidden = selected.size === 0;
  selCount.textContent = selected.size + (selected.size === 1 ? ' elemento selezionato' : ' elementi selezionati');
}
