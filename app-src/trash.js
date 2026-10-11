// trash.js — cestino del proprietario: ciò che i link hanno eliminato o sostituito.
import { S, modalBg, $, CAN_WRITE } from './state.js';
import { apiGet, apiPost } from './net.js';
import { toast, esc, iconFor, fmtBytes, fmtDuration } from './util.js';
import { openModal } from './modal.js';
import { load } from './listing.js';

const fmtWhen = ts => new Date(ts * 1000).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });

export async function trashPanel() {
  const r = await apiGet('trash_list');
  if (!r || !r.ok) { toast((r && r.error) || 'Errore', true); return; }
  // Aperto dal pannello Condivisioni: il suo countdown non serve più.
  if (S.shareTimer) { clearInterval(S.shareTimer); S.shareTimer = null; }
  const list = Array.isArray(r.entries) ? r.entries : [];
  const days = Math.floor(Number(r.days)) || 30;
  const body = list.length ? `<div class="tr-scroll"><table class="utable tr-table"><thead><tr>
      <th>Nome</th><th>Eliminato da</th><th>Quando</th><th>Scade tra</th><th class="tr-num">Dimensione</th>${CAN_WRITE ? '<th></th>' : ''}</tr></thead><tbody>${
    list.map(e => `<tr data-id="${esc(e.id)}">
      <td class="tr-name"><div><i class="ti ${iconFor({ type: e.type === 'dir' ? 'dir' : 'file', name: String(e.name || '') })}"></i> ${esc(e.name)}</div>
        <div class="tr-orig" title="Percorso d'origine">/${esc(e.orig || '')}</div></td>
      <td data-l="Eliminato da">${esc(e.by || '—')}</td>
      <td class="tr-nw" data-l="Quando">${esc(fmtWhen(e.at))}</td>
      <td class="tr-nw" data-l="Scade tra">${e.expires_in > 0 ? esc(fmtDuration(e.expires_in)) : 'a breve'}</td>
      <td class="tr-num tr-nw" data-l="Dimensione">${esc(fmtBytes(Number(e.size) || 0))}</td>
      ${CAN_WRITE ? `<td class="tr-act"><button class="btn tr-btn tr-restore"><i class="ti ti-arrow-back-up"></i> Ripristina</button>
        <button class="btn btn-danger tr-btn tr-purge">Elimina definitivamente</button></td>` : ''}</tr>`).join('')
  }</tbody></table></div>
  <p class="tr-note muted">Gli elementi restano qui ${days} giorni dall'eliminazione e contano nella tua quota.${CAN_WRITE ? '' : ' Per ripristinarli o eliminarli serve il permesso di scrittura.'}</p>`
    : `<p class="muted">Il cestino è vuoto. Qui finiscono per ${days} giorni gli elementi eliminati o sostituiti tramite i link.</p>`;
  openModal(`<div class="modal tr-modal"><h3><i class="ti ti-trash"></i> Cestino</h3>${body}
    <div class="modal-actions">${list.length && CAN_WRITE ? '<button class="btn btn-danger tr-empty-btn" id="tr_empty"><i class="ti ti-trash-x"></i> Svuota cestino</button>' : ''}
      <button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);

  // Una sola operazione alla volta: un doppio clic su «Ripristina» darebbe un 404 spurio.
  let busy = false;
  const btns = () => modalBg.querySelectorAll('.tr-btn, #tr_empty');
  const stillOpen = () => !modalBg.hidden && modalBg.querySelector('.tr-modal');
  const act = fn => async () => {
    if (busy) return;
    busy = true; btns().forEach(b => { b.disabled = true; });
    try { await fn(); } finally { busy = false; btns().forEach(b => { b.disabled = false; }); }
  };
  const refresh = () => (stillOpen() ? trashPanel() : null);

  modalBg.querySelectorAll('tr[data-id]').forEach(tr => {
    const e = list.find(x => String(x.id) === tr.dataset.id);
    if (!e || !CAN_WRITE) return;
    tr.querySelector('.tr-restore').onclick = act(async () => {
      const x = await apiPost('trash_restore', { id: e.id });
      if (!x.ok) { toast(x.error || 'Errore', true); await refresh(); return; }
      toast('Ripristinato in /' + x.path);
      load(S.cwd);
      await refresh();
    });
    tr.querySelector('.tr-purge').onclick = act(async () => {
      if (!confirm(`Eliminare definitivamente «${e.name}»? Non si potrà più recuperare.`)) return;
      const x = await apiPost('trash_purge', { id: e.id });
      if (!x.ok) { toast(x.error || 'Errore', true); await refresh(); return; }
      toast('Eliminato definitivamente');
      await refresh();
    });
  });
  const emptyBtn = $('#tr_empty', modalBg);
  if (emptyBtn) emptyBtn.onclick = act(async () => {
    const n = list.length;
    if (!confirm(`Svuotare il cestino? ${n === 1 ? 'L\'elemento sarà eliminato' : n + ' elementi saranno eliminati'} definitivamente.`)) return;
    // Solo le voci mostrate: quelle arrivate dopo l'apertura del pannello non si toccano.
    const x = await apiPost('trash_purge', { ids: JSON.stringify(list.map(v => v.id)) });
    if (!x.ok) { toast(x.error || 'Errore', true); await refresh(); return; }
    toast('Cestino svuotato');
    await refresh();
  });
}
