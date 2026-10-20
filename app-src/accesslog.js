// accesslog.js — registro degli accessi: tabella filtrabile (amministrazione) e
// riepilogo per link (pannello Condivisioni). Dati da api.php?action=access_list.
import { modalBg, $, USER } from './state.js';
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
const flag = cc => String(cc).toUpperCase().replace(/[A-Z]/g, c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));
function where(r) {
  if (r.cc === 'LAN') return '<span class="muted">rete locale</span>';
  if (r.cc) return `<span title="Posizione approssimativa (IP Geolocation by DB-IP)">${flag(r.cc)} ${esc(r.city ? r.city + ', ' : '')}${esc(r.country || r.cc)}</span>`;
  return '<span class="muted" title="Posizione non disponibile: database GeoIP assente o indirizzo sconosciuto">—</span>';
}
const who = a => String(a || '-').replace(/^user:/, '').replace(/^link:/, 'link «').replace(/^(link «.*)$/, '$1»').replace(/^tentativo:/, 'tentativo: ');

function rowHtml(r) {
  const bad = r.status && r.status !== 'ok';
  const what = (r.path ? esc(r.path) : '') + (r.to ? ' → ' + esc(r.to) : '') + (r.size ? ` <span class="muted">(${fmtBytes(Number(r.size) || 0)})</span>` : '');
  return `<tr>
    <td style="white-space:nowrap">${esc(when(r.ts))}</td>
    <td class="${bad ? 'acc-bad' : ''}">${esc(EVENTS[r.event] || r.event)}${r.via ? ` <span class="muted">· ${esc(VIA[r.via] || r.via)}</span>` : ''}</td>
    <td class="acc-who" data-actor="${esc(r.actor || '')}">${esc(who(r.actor))}</td>
    <td>${what || '<span class="muted">—</span>'}</td>
    <td class="acc-where">${where(r)}</td>
    <td class="acc-ip" data-ip="${esc(r.ip || '')}" title="${esc(r.ua || '')}">${esc(r.ip || '')}</td></tr>`;
}

// Tabella con filtri e «Mostra altri» (paginazione a cursore). fixed: filtri imposti (es. token).
export function accessTable(host, fixed = {}, { filters = true, initial = {}, fixedNote = '' } = {}) {
  host.innerHTML = (filters ? `<div class="acc-filters">
      <input type="date" id="af_from" title="Dal"><input type="date" id="af_to" title="Al">
      <select id="af_event"><option value="">Tutti gli eventi</option>${Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      <input type="text" id="af_actor" placeholder="Chi (utente o link)"><input type="text" id="af_path" placeholder="Percorso"><input type="text" id="af_ip" placeholder="IP"><input type="text" id="af_cc" placeholder="Paese (es. IT)" maxlength="3" size="8">
      <button class="btn" id="af_go"><i class="ti ti-search"></i> Filtra</button>
      <a class="btn" id="af_csv"><i class="ti ti-file-spreadsheet"></i> CSV</a>${fixedNote}</div>` : '')
    + `<div class="acc-body"><p class="muted">Caricamento…</p></div>`;
  const body = host.querySelector('.acc-body');
  const val = id => (filters && $('#' + id, host) ? $('#' + id, host).value.trim() : '');
  const params = () => {
    const p = { ...fixed };
    [['from', 'af_from'], ['to', 'af_to'], ['event', 'af_event'], ['actor', 'af_actor'], ['path', 'af_path'], ['ip', 'af_ip'], ['cc', 'af_cc']]
      .forEach(([k, id]) => { const v = val(id); if (v) p[k] = v; });
    return p;
  };
  let rows = [];
  const load = async (cursor = '') => {
    const r = await apiGet('access_list', { ...params(), limit: 200, ...(cursor ? { cursor } : {}) });
    if (!r.ok) { body.innerHTML = `<p class="acc-bad">${esc(r.error || 'Errore')}</p>`; return; }
    rows = cursor ? rows.concat(r.rows) : r.rows;
    body.innerHTML = rows.length
      ? `<table class="utable acc-table"><thead><tr><th>Quando</th><th>Evento</th><th>Chi</th><th>File</th><th>Da dove</th><th>IP</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`
        + (r.next ? '<div style="text-align:center;margin-top:8px"><button class="btn" id="af_more">Mostra altri</button></div>' : '')
      : '<p class="muted">Nessun accesso registrato con questi filtri.</p>';
    if (r.next) $('#af_more', body).onclick = () => load(r.next);
    if (filters) {
      body.querySelectorAll('[data-ip]').forEach(td => td.onclick = () => { $('#af_ip', host).value = td.dataset.ip; load(); });
      body.querySelectorAll('[data-actor]').forEach(td => td.onclick = () => { $('#af_actor', host).value = td.dataset.actor.replace(/^(user|link):/, ''); load(); });
    }
  };
  if (filters) {
    if (initial.path) $('#af_path', host).value = initial.path;
    $('#af_go', host).onclick = () => load();
    host.querySelectorAll('.acc-filters input').forEach(i => { i.onkeydown = e => { if (e.key === 'Enter') load(); }; });
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
  const countries = [...new Set(rows.filter(x => x.cc && x.cc !== 'LAN').map(x => x.cc))];
  openModal(`<div class="modal wide"><h3><i class="ti ti-activity"></i> Accessi al link${s.label ? ' di «' + esc(s.label) + '»' : ''}</h3>
    <p class="muted" style="margin-top:-6px">${esc(s.name)} · ultimi ${rows.length} eventi</p>
    ${r.ok ? `<div class="acc-sum"><span><b>${n('share_view')}</b>visite</span><span><b>${n('download') + n('zip')}</b>download</span><span><b>${n('preview')}</b>anteprime</span><span><b>${n('upload')}</b>caricamenti</span><span><b>${ips}</b>IP distinti</span><span><b>${countries.length ? countries.map(flag).join(' ') : '—'}</b>${countries.length === 1 ? 'paese' : 'paesi'}</span><span><b>${rows[0] ? esc(when(rows[0].ts)) : '—'}</b>ultimo accesso</span></div>` : ''}
    <div id="acc_host" class="sh-scroll"></div>
    <p class="muted" style="font-size:11px">Ogni clic su un file è registrato con data, ora e indirizzo IP.</p>
    <div class="modal-actions"><button class="btn" id="acc_back"><i class="ti ti-arrow-left"></i> Condivisioni</button><a class="btn" href="index.php?view=registro&token=${esc(String(s.token).slice(0, 8))}"><i class="ti ti-activity"></i> Apri nel registro</a><button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
  const host = $('#acc_host', modalBg);
  if (!r.ok) host.innerHTML = `<p class="acc-bad">${esc(r.error || 'Errore')}</p>`;
  else host.innerHTML = rows.length
    ? `<table class="utable acc-table"><thead><tr><th>Quando</th><th>Evento</th><th>Chi</th><th>File</th><th>Da dove</th><th>IP</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`
    : '<p class="muted">Nessun accesso registrato per questo link.</p>';
  $('#acc_back', modalBg).onclick = back;
}

// Pagina «Registro» (index.php?view=registro): tabella a tutta pagina; ?path= precompila il
// percorso (icona «Accessi» di un elemento), ?token= limita a un link; l'admin sceglie Tutti/Solo i miei.
export function registroPage(host) {
  if (!host) return;
  const q = new URLSearchParams(location.search);
  const fixed = {};
  const token = (q.get('token') || '').replace(/[^0-9a-f]/gi, '').slice(0, 8);
  if (token) fixed.token = token;
  const initial = { path: (q.get('path') || '').replace(/^\/+/, '') };
  const fixedNote = token ? `<span class="acc-fixed"><i class="ti ti-link"></i> solo il link ${esc(token)}… <a href="index.php?view=registro">tutti gli eventi</a></span>` : '';
  let scope = 'all';
  const seg = document.getElementById('accScope');
  const render = () => accessTable(host, { ...fixed, ...(scope === 'mine' ? { owner: USER } : {}) }, { initial, fixedNote });
  if (seg) seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    scope = b.dataset.scope;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    render();
  });
  render();
  const note = document.createElement('p');
  note.className = 'acc-note';
  note.innerHTML = 'Ogni evento riporta data e ora, chi ha agito (utente o link), file, esito e indirizzo IP della connessione. Conservazione: 12 mesi. La posizione è approssimativa, a livello di città o di provider · IP Geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a>.';
  host.after(note);
}
