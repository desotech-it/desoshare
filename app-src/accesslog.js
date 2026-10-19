// accesslog.js — registro degli accessi: tabella filtrabile (amministrazione) e
// riepilogo per link (pannello Condivisioni). Dati da api.php?action=access_list.
import { modalBg, $ } from './state.js';
import { apiGet } from './net.js';
import { esc, fmtBytes } from './util.js';
import { openModal } from './modal.js';

export const EVENTS = {
  share_view: 'Visita del link', download: 'Download', preview: 'Anteprima', zip: 'ZIP',
  upload: 'Caricamento', delete: 'Eliminazione', rename: 'Rinomina', mkdir: 'Nuova cartella',
  login: 'Accesso', login_fail: 'Accesso fallito', share_pin_ok: 'PIN corretto', share_pin_fail: 'PIN errato',
  share_lookup_fail: 'Link inesistente',
};
const VIA = { presigned: 'richiesta a Wasabi', server: 'tramite server', direct: 'diretto', sso: 'SSO' };
const when = ts => { try { return new Date(ts).toLocaleString('it-IT'); } catch (_) { return ts; } };
const who = a => String(a || '-').replace(/^user:/, '').replace(/^link:/, 'link «').replace(/^(link «.*)$/, '$1»').replace(/^tentativo:/, 'tentativo: ');

function rowHtml(r) {
  const bad = r.status && r.status !== 'ok';
  const what = (r.path ? esc(r.path) : '') + (r.to ? ' → ' + esc(r.to) : '') + (r.size ? ` <span class="muted">(${fmtBytes(Number(r.size) || 0)})</span>` : '');
  return `<tr>
    <td style="white-space:nowrap">${esc(when(r.ts))}</td>
    <td class="${bad ? 'acc-bad' : ''}">${esc(EVENTS[r.event] || r.event)}${r.via ? ` <span class="muted">· ${esc(VIA[r.via] || r.via)}</span>` : ''}</td>
    <td class="acc-who" data-actor="${esc(r.actor || '')}">${esc(who(r.actor))}</td>
    <td>${what || '<span class="muted">—</span>'}</td>
    <td class="acc-ip" data-ip="${esc(r.ip || '')}" title="${esc(r.ua || '')}">${esc(r.ip || '')}</td></tr>`;
}

// Tabella con filtri e «Mostra altri» (paginazione a cursore). fixed: filtri imposti (es. token).
export function accessTable(host, fixed = {}, { filters = true } = {}) {
  host.innerHTML = (filters ? `<div class="acc-filters">
      <input type="date" id="af_from" title="Dal"><input type="date" id="af_to" title="Al">
      <select id="af_event"><option value="">Tutti gli eventi</option>${Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      <input type="text" id="af_actor" placeholder="Chi (utente o link)"><input type="text" id="af_path" placeholder="Percorso"><input type="text" id="af_ip" placeholder="IP">
      <button class="btn" id="af_go"><i class="ti ti-search"></i> Filtra</button>
      <a class="btn" id="af_csv"><i class="ti ti-file-spreadsheet"></i> CSV</a></div>` : '')
    + `<div class="acc-body"><p class="muted">Caricamento…</p></div>`;
  const body = host.querySelector('.acc-body');
  const val = id => (filters && $('#' + id, host) ? $('#' + id, host).value.trim() : '');
  const params = () => {
    const p = { ...fixed };
    [['from', 'af_from'], ['to', 'af_to'], ['event', 'af_event'], ['actor', 'af_actor'], ['path', 'af_path'], ['ip', 'af_ip']]
      .forEach(([k, id]) => { const v = val(id); if (v) p[k] = v; });
    return p;
  };
  let rows = [];
  const load = async (cursor = '') => {
    const r = await apiGet('access_list', { ...params(), limit: 200, ...(cursor ? { cursor } : {}) });
    if (!r.ok) { body.innerHTML = `<p class="acc-bad">${esc(r.error || 'Errore')}</p>`; return; }
    rows = cursor ? rows.concat(r.rows) : r.rows;
    body.innerHTML = rows.length
      ? `<table class="utable acc-table"><thead><tr><th>Quando</th><th>Evento</th><th>Chi</th><th>File</th><th>IP</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`
        + (r.next ? '<div style="text-align:center;margin-top:8px"><button class="btn" id="af_more">Mostra altri</button></div>' : '')
      : '<p class="muted">Nessun accesso registrato con questi filtri.</p>';
    if (r.next) $('#af_more', body).onclick = () => load(r.next);
    if (filters) {
      body.querySelectorAll('[data-ip]').forEach(td => td.onclick = () => { $('#af_ip', host).value = td.dataset.ip; load(); });
      body.querySelectorAll('[data-actor]').forEach(td => td.onclick = () => { $('#af_actor', host).value = td.dataset.actor.replace(/^(user|link):/, ''); load(); });
    }
  };
  if (filters) {
    $('#af_go', host).onclick = () => load();
    $('#af_csv', host).onclick = () => { location.href = 'api.php?' + new URLSearchParams({ action: 'access_export', ...params() }); };
  }
  load();
}

// Accessi di un link: riepilogo (visite, download, IP distinti, ultimo accesso) + elenco.
export async function shareAccessPanel(s, back) {
  const r = await apiGet('access_list', { token: String(s.token).slice(0, 8), limit: 500 });
  const rows = r.ok ? r.rows : [];
  const n = ev => rows.filter(x => x.event === ev).length;
  const ips = new Set(rows.map(x => x.ip)).size;
  openModal(`<div class="modal wide"><h3><i class="ti ti-activity"></i> Accessi al link${s.label ? ' di «' + esc(s.label) + '»' : ''}</h3>
    <p class="muted" style="margin-top:-6px">${esc(s.name)} · ultimi ${rows.length} eventi</p>
    ${r.ok ? `<div class="acc-sum"><span><b>${n('share_view')}</b>visite</span><span><b>${n('download') + n('zip')}</b>download</span><span><b>${n('preview')}</b>anteprime</span><span><b>${n('upload')}</b>caricamenti</span><span><b>${ips}</b>IP distinti</span><span><b>${rows[0] ? esc(when(rows[0].ts)) : '—'}</b>ultimo accesso</span></div>` : ''}
    <div id="acc_host" class="sh-scroll"></div>
    <p class="muted" style="font-size:11px">Ogni clic su un file è registrato con data, ora e indirizzo IP.</p>
    <div class="modal-actions"><button class="btn" id="acc_back"><i class="ti ti-arrow-left"></i> Condivisioni</button><button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
  const host = $('#acc_host', modalBg);
  if (!r.ok) host.innerHTML = `<p class="acc-bad">${esc(r.error || 'Errore')}</p>`;
  else host.innerHTML = rows.length
    ? `<table class="utable acc-table"><thead><tr><th>Quando</th><th>Evento</th><th>Chi</th><th>File</th><th>IP</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`
    : '<p class="muted">Nessun accesso registrato per questo link.</p>';
  $('#acc_back', modalBg).onclick = back;
}
