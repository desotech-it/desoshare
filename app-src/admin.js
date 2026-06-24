// admin.js — pannello Amministrazione: Utenti (quota/consumo), Impostazioni (storage+SSO), Registro.
import { modalBg, $ } from './state.js';
import { apiGet, apiPost } from './net.js';
import { toast, esc, fmtTime } from './util.js';
import { openModal } from './modal.js';

export async function adminPanel(section) {
  section = section || 'users';
  const tab = (k, ic, lbl) => `<button class="btn ${section === k ? 'btn-primary' : ''}" data-sec="${k}"><i class="ti ${ic}"></i> ${lbl}</button>`;
  openModal(`<div class="modal wide admin-modal"><h3><i class="ti ti-settings"></i> Amministrazione</h3>
    <div class="adm-tabs">
      ${tab('users', 'ti-users-group', 'Utenti')}${tab('settings', 'ti-adjustments', 'Impostazioni')}${tab('audit', 'ti-history', 'Registro')}
    </div>
    <div id="adm_body">Caricamento…</div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="adm_save" hidden><i class="ti ti-device-floppy"></i> Salva</button>
      <button class="btn" onclick="closeModal()">Chiudi</button>
    </div></div>`);
  modalBg.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => adminPanel(b.dataset.sec));
  const saveBtn = $('#adm_save', modalBg);
  if (saveBtn) saveBtn.hidden = (section !== 'settings');   // "Salva" solo nella tab Impostazioni
  const body = $('#adm_body', modalBg);
  if (section === 'settings') await renderSettingsSection(body);
  else if (section === 'audit') await renderAuditSection(body);
  else await renderUsersSection(body);
}

async function renderUsersSection(body, usageRefresh) {
  const useParams = usageRefresh ? { refresh: usageRefresh } : {};
  const [res, use] = await Promise.all([apiGet('users_list'), apiGet('usage_list', useParams)]);
  if (!res.ok) { body.textContent = res.error || 'Errore'; return; }
  const usage = {};
  if (use && use.ok) use.users.forEach(u => usage[u.username] = u);
  const spaceCell = (name) => {
    const u = usage[name];
    if (!u) return '<span class="muted">—</span>';
    if (!u.quota) return `${esc(u.usage_h)} <span class="muted">/ illimitata</span>${u.stale ? ' <span class="muted" title="valore in cache">~</span>' : ''}`;
    const pct = u.pct == null ? 0 : u.pct;
    const cls = pct >= 100 ? 'q-red' : (pct >= 80 ? 'q-amber' : 'q-green');
    return `<div class="quota-bar"><div class="${cls}" style="width:${Math.min(100, pct)}%"></div></div>`
      + `<span class="quota-txt">${esc(u.usage_h)} / ${esc(u.quota_h)} (${pct}%)${u.stale ? ' ~' : ''}</span>`;
  };
  const rows = res.users.map(u => `
    <tr><td><i class="ti ti-user"></i> ${esc(u.username)}</td>
      <td>${u.role === 'admin' ? '<b>admin</b>' : 'utente'}</td>
      <td>${u.permission === 'write' ? 'lettura e scrittura' : 'sola lettura'}</td>
      <td class="uspace">${spaceCell(u.username)}</td>
      <td class="uact">
        <i class="ti ti-refresh" title="Aggiorna spazio" data-refresh="${esc(u.username)}"></i>
        <i class="ti ti-edit" data-u="${esc(u.username)}" data-r="${u.role}" data-p="${u.permission}" data-q="${u.quota_mb || 0}"></i>
        <i class="ti ti-trash" data-del="${esc(u.username)}"></i></td></tr>`).join('');
  body.innerHTML = `<div style="text-align:right;margin-bottom:8px"><button class="btn btn-primary" id="u_new"><i class="ti ti-user-plus"></i> Nuovo utente</button></div>
    <table class="utable"><thead><tr><th>Utente</th><th>Ruolo</th><th>Permessi</th><th>Spazio</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#u_new', modalBg).onclick = () => userForm();
  modalBg.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const name = b.dataset.del;
    if (!confirm(`Eliminare l'utente "${name}"?\nLe sue condivisioni pubbliche verranno revocate.`)) return;
    const purge = confirm(`Eliminare anche TUTTI i file di "${name}" dallo storage?\n\nOK = elimina anche i file (irreversibile)\nAnnulla = conserva i file`);
    const r = await apiPost('user_delete', { username: name, purge: purge ? '1' : '0' });
    if (r.ok) { toast('Utente eliminato'); adminPanel('users'); } else toast(r.error || 'Errore', true);
  });
  modalBg.querySelectorAll('[data-refresh]').forEach(b => b.onclick = () => renderUsersSection(body, b.dataset.refresh));
  modalBg.querySelectorAll('[data-u]').forEach(b => b.onclick = () =>
    userForm({ username: b.dataset.u, role: b.dataset.r, permission: b.dataset.p, quota_mb: parseInt(b.dataset.q || '0', 10) }));
}

function oidcSection(o) {
  const on = !!o.enabled;
  const envNote = o.from_env ? ' <span class="muted" style="font-size:11px">(secret presente anche da ambiente)</span>' : '';
  // campo come "cella" della griglia a 2 colonne
  const fld = (id, label, val, ph = '', type = 'text') =>
    `<div class="fld"><label>${label}</label><input type="${type}" id="${id}" value="${type === 'password' ? '' : esc(val || '')}" placeholder="${esc(ph)}" autocomplete="${type === 'password' ? 'new-password' : 'off'}"></div>`;
  return `
    <h3 style="margin:18px 0 4px;font-size:15px;display:flex;align-items:center;gap:6px"><i class="ti ti-shield-lock"></i> SSO / OpenID Connect</h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Accesso "Accedi con desoauth" via OAuth2/OIDC. I valori qui hanno la precedenza su quelli in <code>.htaccess</code>/ambiente.</p>
    <label class="sw"><input type="checkbox" id="oidc_enabled" ${on ? 'checked' : ''}> Abilita SSO${envNote}</label>
    <div id="oidc_box" style="margin-top:8px${on ? '' : ';display:none'}">
      <label style="margin-top:8px">Issuer</label>
      <div style="display:flex;gap:6px">
        <input type="text" id="oidc_issuer" value="${esc(o.issuer || '')}" placeholder="https://auth.deso.tech/application/o/desoshare/" autocomplete="off" style="flex:1">
        <button class="btn" id="oidc_disco" type="button" title="Compila gli endpoint dall'issuer"><i class="ti ti-download"></i> Discovery</button>
      </div>
      <span id="oidc_discomsg" class="muted" style="font-size:12px"></span>
      <div class="grid2" style="margin-top:8px">
        ${fld('oidc_client_id', 'Client ID', o.client_id, 'Pubj2…')}
        <div class="fld"><label>Client Secret</label>
          <input type="password" id="oidc_secret" value="" autocomplete="new-password" placeholder="${o.has_secret ? '•••••••• (invariato)' : 'inserisci il secret'}">
          <span class="muted" style="font-size:11px">Vuoto = non modificare (cifrato sul server)</span></div>
        ${fld('oidc_admin_group', 'Gruppo admin', o.admin_group, 'desoshare_admin')}
        ${fld('oidc_rw_group', 'Gruppo lettura-scrittura', o.rw_group, 'desoshare_user')}
      </div>
      <label style="margin-top:8px">Scopes</label>
      <input type="text" id="oidc_scopes" value="${esc(o.scopes || '')}" placeholder="openid email profile" autocomplete="off">
      <details class="adv">
        <summary>Endpoint avanzati (di solito compilati dal Discovery)</summary>
        <div class="grid2" style="margin-top:8px">
          ${fld('oidc_authz', 'Authorization endpoint', o.authz)}
          ${fld('oidc_token', 'Token endpoint', o.token)}
          ${fld('oidc_userinfo', 'Userinfo endpoint', o.userinfo)}
          ${fld('oidc_jwks', 'JWKS URI', o.jwks)}
          ${fld('oidc_endsession', 'End-session endpoint', o.endsession)}
          ${fld('oidc_redirect', 'Redirect URI', o.redirect)}
        </div>
      </details>
      <div style="margin-top:10px"><button class="btn" id="oidc_testbtn" type="button"><i class="ti ti-plug-connected"></i> Prova SSO</button> <span id="oidc_testmsg" class="muted" style="font-size:12px"></span></div>
    </div>`;
}

async function renderSettingsSection(body) {
  const s = await apiGet('settings_get');
  if (!s.ok) { body.textContent = s.error || 'Errore'; return; }
  const st = s.storage || { backend: 'local' };
  const isS3 = st.backend === 's3';
  const localOn = s.local_auth_enabled !== false;
  body.innerHTML = `
    <div class="set-tabs">
      <button type="button" class="active" data-pane="general"><i class="ti ti-adjustments"></i> Generale</button>
      <button type="button" data-pane="storage"><i class="ti ti-database"></i> Archiviazione</button>
      <button type="button" data-pane="auth"><i class="ti ti-shield-lock"></i> Autenticazione</button>
    </div>

    <div class="set-pane" data-pane="general">
      <label>Titolo del sito</label>
      <input type="text" id="set_title" value="${esc(s.site_title)}" maxlength="40" placeholder="Share">
      <label style="margin-top:10px">Intervallo di sincronizzazione note (ms)</label>
      <input type="text" id="set_poll" value="${s.note_poll_ms}">
      <label style="margin-top:10px">Dimensione massima di una nota (MB)</label>
      <input type="text" id="set_maxmb" value="${Math.round(s.note_max_bytes / 1048576)}">
      <label style="margin-top:10px">Quota predefinita per nuovo utente (MB, 0 = illimitata)</label>
      <input type="text" id="set_defquota" value="${Math.round((s.default_quota_bytes || 0) / 1048576)}">
    </div>

    <div class="set-pane" data-pane="storage" hidden>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Dove vengono salvati i file caricati. S3 usa uno storage esterno compatibile (es. Wasabi).</p>
      <label>Backend</label>
      <select id="set_backend">
        <option value="local"${isS3 ? '' : ' selected'}>Locale (server)</option>
        <option value="s3"${isS3 ? ' selected' : ''}>S3 compatibile (Wasabi)</option>
      </select>
      <div id="s3_box" style="margin-top:10px${isS3 ? '' : ';display:none'}">
        <label>Endpoint</label>
        <input type="text" id="s3_endpoint" value="${esc(st.endpoint || '')}" placeholder="s3.eu-south-1.wasabisys.com">
        <label style="margin-top:8px">Regione</label>
        <input type="text" id="s3_region" value="${esc(st.region || '')}" placeholder="eu-south-1">
        <label style="margin-top:8px">Bucket</label>
        <input type="text" id="s3_bucket" value="${esc(st.bucket || '')}" placeholder="desotech-desoshare">
        <label style="margin-top:8px">Access Key ID</label>
        <input type="text" id="s3_key" value="${esc(st.access_key || '')}" autocomplete="off">
        <label style="margin-top:8px">Secret Access Key</label>
        <input type="password" id="s3_secret" value="" autocomplete="new-password" placeholder="${st.has_secret ? '•••••••• (invariato)' : 'inserisci il secret'}">
        <p class="muted" style="font-size:12px;margin:4px 0 0">Lascia vuoto il secret per non modificarlo. È salvato cifrato sul server.</p>
        <div style="margin-top:8px"><button class="btn" id="s3_testbtn"><i class="ti ti-plug-connected"></i> Prova connessione</button> <span id="s3_testmsg" class="muted" style="font-size:12px"></span></div>
      </div>
    </div>

    <div class="set-pane" data-pane="auth" hidden>
      <h3 style="margin:2px 0 4px;font-size:15px;display:flex;align-items:center;gap:6px"><i class="ti ti-key"></i> Autenticazione locale</h3>
      <label class="sw"><input type="checkbox" id="local_auth_enabled" ${localOn ? 'checked' : ''}> Abilita login con username e password</label>
      <p class="muted" style="font-size:12px;margin:4px 0 0">Se disattivata, l'accesso sarà possibile <b>solo via SSO</b>: assicurati che l'SSO sia abilitato e funzionante, altrimenti rischi di restare fuori.</p>
      ${oidcSection(s.oidc || {})}
    </div>`;

  // sotto-tab: mostra solo il pannello selezionato (i campi degli altri restano nel DOM)
  modalBg.querySelectorAll('.set-tabs button').forEach(b => b.onclick = () => {
    modalBg.querySelectorAll('.set-tabs button').forEach(x => x.classList.toggle('active', x === b));
    modalBg.querySelectorAll('.set-pane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.pane; });
  });

  const backendSel = $('#set_backend', modalBg);
  backendSel.onchange = () => { $('#s3_box', modalBg).style.display = backendSel.value === 's3' ? '' : 'none'; };

  const s3fields = () => ({
    storage_backend: backendSel.value,
    s3_endpoint: $('#s3_endpoint', modalBg) ? $('#s3_endpoint', modalBg).value : '',
    s3_region:   $('#s3_region', modalBg)   ? $('#s3_region', modalBg).value   : '',
    s3_bucket:   $('#s3_bucket', modalBg)   ? $('#s3_bucket', modalBg).value   : '',
    s3_key:      $('#s3_key', modalBg)      ? $('#s3_key', modalBg).value      : '',
    s3_secret:   $('#s3_secret', modalBg)   ? $('#s3_secret', modalBg).value   : '',
  });

  const testBtn = $('#s3_testbtn', modalBg);
  if (testBtn) testBtn.onclick = async () => {
    const msg = $('#s3_testmsg', modalBg);
    msg.textContent = 'verifica in corso…'; msg.style.color = '';
    const r = await apiPost('s3_test', s3fields());
    msg.textContent = r.ok ? (r.message || 'Connessione riuscita') : (r.error || 'Connessione fallita');
    msg.style.color = r.ok ? 'var(--ok, #1a7f37)' : 'var(--danger, #c0392b)';
  };

  // ─ SSO / OIDC ─
  const ssoEnabled = $('#oidc_enabled', modalBg);
  if (ssoEnabled) ssoEnabled.onchange = () => { $('#oidc_box', modalBg).style.display = ssoEnabled.checked ? '' : 'none'; };
  const val = id => { const el = $('#' + id, modalBg); return el ? el.value.trim() : ''; };
  const oidcfields = () => ({
    oidc_present: '1',
    oidc_enabled: ssoEnabled && ssoEnabled.checked ? '1' : '0',
    oidc_client_id: val('oidc_client_id'), oidc_secret: $('#oidc_secret', modalBg) ? $('#oidc_secret', modalBg).value : '',
    oidc_issuer: val('oidc_issuer'), oidc_authz: val('oidc_authz'), oidc_token: val('oidc_token'),
    oidc_userinfo: val('oidc_userinfo'), oidc_jwks: val('oidc_jwks'), oidc_endsession: val('oidc_endsession'),
    oidc_redirect: val('oidc_redirect'), oidc_scopes: val('oidc_scopes'),
    oidc_admin_group: val('oidc_admin_group'), oidc_rw_group: val('oidc_rw_group'),
  });
  const disco = $('#oidc_disco', modalBg);
  if (disco) disco.onclick = async () => {
    const msg = $('#oidc_discomsg', modalBg);
    msg.textContent = 'lettura discovery…'; msg.style.color = '';
    const r = await apiPost('oidc_discovery', { issuer: val('oidc_issuer') });
    if (!r.ok) { msg.textContent = r.error || 'Discovery fallita'; msg.style.color = 'var(--danger, #c0392b)'; return; }
    const d = r.discovery;
    const set = (id, v) => { const el = $('#' + id, modalBg); if (el && v) el.value = v; };
    set('oidc_authz', d.authz); set('oidc_token', d.token); set('oidc_userinfo', d.userinfo);
    set('oidc_jwks', d.jwks); set('oidc_endsession', d.endsession);
    msg.textContent = 'Endpoint compilati dal discovery ✓'; msg.style.color = 'var(--ok, #1a7f37)';
  };
  const ssoTest = $('#oidc_testbtn', modalBg);
  if (ssoTest) ssoTest.onclick = async () => {
    const msg = $('#oidc_testmsg', modalBg);
    msg.textContent = 'verifica in corso…'; msg.style.color = '';
    const r = await apiPost('oidc_test', oidcfields());
    msg.textContent = r.ok ? (r.message || 'OK') : (r.error || 'Verifica fallita');
    msg.style.color = r.ok ? 'var(--ok, #1a7f37)' : 'var(--danger, #c0392b)';
  };

  $('#adm_save', modalBg).onclick = async () => {
    const r = await apiPost('settings_save', Object.assign({
      site_title: $('#set_title', modalBg).value,
      note_poll_ms: $('#set_poll', modalBg).value,
      note_max_mb: $('#set_maxmb', modalBg).value,
      default_quota_mb: $('#set_defquota', modalBg).value,
      local_auth_enabled: $('#local_auth_enabled', modalBg) && $('#local_auth_enabled', modalBg).checked ? '1' : '0',
    }, s3fields(), oidcfields()));
    if (r.ok) toast('Impostazioni salvate'); else toast(r.error || 'Errore', true);
  };
}

async function renderAuditSection(body) {
  const r = await apiGet('audit_list');
  if (!r.ok) { body.textContent = r.error || 'Errore'; return; }
  if (!r.entries.length) { body.innerHTML = '<p class="muted">Nessuna attività registrata.</p>'; return; }
  body.innerHTML = `<table class="utable">
    <thead><tr><th>Quando</th><th>Utente</th><th>Azione</th><th>Dettaglio</th></tr></thead><tbody>${
    r.entries.map(e => `<tr><td style="white-space:nowrap">${esc(fmtTime(e.time))}</td><td>${esc(e.user)}</td><td>${esc(e.action)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('')
    }</tbody></table>`;
}

function userForm(u = null) {
  const editing = !!u;
  const perm = u ? u.permission : 'read';
  const isAdminRole = u ? u.role === 'admin' : false;
  openModal(`<div class="modal"><h3><i class="ti ti-user-plus"></i> ${editing ? 'Modifica utente' : 'Nuovo utente'}</h3>
    <label>Username</label><input type="text" id="u_name" value="${u ? esc(u.username) : ''}" ${editing ? 'readonly' : ''}>
    <label>Password ${editing ? '(lascia vuoto per non cambiarla)' : ''}</label>
    <input type="text" id="u_pass" placeholder="${editing ? '••••••' : 'almeno 6 caratteri'}">
    <label>Permessi</label>
    <div class="perm-row" id="u_perm">
      <div class="perm-opt ${perm === 'read' ? 'active' : ''}" data-v="read"><i class="ti ti-eye"></i> Sola lettura</div>
      <div class="perm-opt ${perm === 'write' ? 'active' : ''}" data-v="write"><i class="ti ti-pencil"></i> Lettura e scrittura</div>
    </div>
    <label style="margin-top:12px">Quota di archiviazione (MB, 0 = illimitata)</label>
    <input type="text" id="u_quota" value="${u && u.quota_mb ? u.quota_mb : 0}">
    <label style="margin-top:12px"><input type="checkbox" id="u_admin" ${isAdminRole ? 'checked' : ''}> Amministratore (gestione utenti + accesso completo)</label>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="u_save">Salva</button></div></div>`);
  let chosen = perm;
  modalBg.querySelectorAll('.perm-opt').forEach(o => o.onclick = () => {
    chosen = o.dataset.v;
    modalBg.querySelectorAll('.perm-opt').forEach(x => x.classList.toggle('active', x === o));
  });
  $('#u_save', modalBg).onclick = async () => {
    const data = {
      username: $('#u_name', modalBg).value.trim(),
      password: $('#u_pass', modalBg).value,
      permission: chosen,
      role: $('#u_admin', modalBg).checked ? 'admin' : 'user',
      quota_mb: $('#u_quota', modalBg).value.trim(),
    };
    if (editing) data.original = u.username;
    const r = await apiPost('user_save', data);
    if (r.ok) { toast('Utente salvato'); adminPanel('users'); } else toast(r.error || 'Errore', true);
  };
}
