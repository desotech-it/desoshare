// Smoke test del frontend: esegue assets/app.js in un DOM simulato (jsdom)
// riproducendo l'HTML generato da index.php, per intercettare errori di runtime
// al caricamento della pagina (regressioni JS) senza un browser vero.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(join(here, '..', 'assets', 'app.js'), 'utf8');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failures++; console.log('  ✗ ' + m); };

// HTML che rispecchia render_app() di index.php (il "contratto" PHP↔JS)
function pageHtml(canWrite, isAdmin) {
  const w = canWrite ? `
        <button class="btn btn-primary" id="btnUpload">Carica file</button>
        <button class="btn" id="btnUploadFolder">Carica cartella</button>
        <button class="btn" id="btnNewFolder">Nuova cartella</button>
        <button class="btn" id="btnNewFile">Nuovo file</button>
        <button class="btn" id="btnNewNote">Nuova nota</button>` : '';
  const adminBtn = isAdmin ? `<button class="btn" id="btnAdmin">Amministrazione</button>` : '';
  const delSel = canWrite ? `<button class="btn btn-danger" id="btnDelSel">Elimina</button>` : '';
  return `<!doctype html><html><body>
    <div id="app" data-csrf="testcsrf" data-user="admin" data-admin="${isAdmin ? 1 : 0}" data-write="${canWrite ? 1 : 0}" data-jszipv="1">
      <header class="topbar"><div class="brand">Share</div><div><button id="btnShares">Condivisioni</button>${adminBtn}<a id="logout">Esci</a></div></header>
      <div class="toolbar">${w}
        <button class="btn" id="btnZipCurrent">Scarica ZIP</button>
        <div class="spacer"></div>
        <button class="btn" id="btnRefresh">Aggiorna</button>
        <div class="search"><input type="text" id="search"></div>
        <input type="file" id="fileInput" multiple hidden>
        <input type="file" id="folderInput" webkitdirectory directory multiple hidden>
      </div>
      <nav class="crumbs" id="crumbs"></nav>
      <div class="listing"><div class="list-head"><input type="checkbox" id="checkAll"></div>
        <div id="rows"></div><div id="empty" hidden></div></div>
      <div class="selbar" id="selbar" hidden><span id="selCount"></span>
        <button class="btn" id="btnZipSel">ZIP</button>${delSel}</div>
    </div>
    <div class="modal-bg" id="modalBg" hidden></div>
  </body></html>`;
}

const listResponse = {
  ok: true, path: '/', can_write: true, is_admin: true,
  items: [
    { name: 'documenti', type: 'dir', size: 0, size_h: '', mtime: '01/01/2026' },
    { name: 'foto.jpg', type: 'file', size: 2048, size_h: '2.0 KB', mtime: '02/01/2026' },
    { name: 'nota.md', type: 'file', size: 12, size_h: '12 B', mtime: '03/01/2026' },
  ],
};

async function run(label, canWrite, isAdmin) {
  console.log(`\nCaso: ${label}`);
  const dom = new JSDOM(pageHtml(canWrite, isAdmin), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  // stub di rete: ogni fetch restituisce la risposta "list"
  win.fetch = async () => ({ ok: true, json: async () => listResponse, text: async () => JSON.stringify(listResponse) });
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  if (!win.crypto) win.crypto = {};
  if (!win.crypto.subtle) win.crypto.subtle = { digest: async () => new Uint8Array(32).buffer };

  let loadError = null;
  win.onerror = (msg, src, line, col, err) => { loadError = err || new Error(msg); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });

  try {
    win.eval(appJs);
  } catch (e) {
    bad(`app.js ha lanciato un'eccezione al caricamento: ${e.message}`);
    return;
  }
  ok('app.js eseguito senza eccezioni sincrone');

  // attende il microtask di load('') che popola le righe
  await new Promise(r => setTimeout(r, 30));

  if (loadError) { bad(`errore asincrono al caricamento: ${loadError.message}`); }
  else ok('nessun errore asincrono');

  const rows = win.document.querySelectorAll('#rows .row');
  if (rows.length === 3) ok(`listing popolato (${rows.length} righe)`);
  else bad(`listing NON popolato (righe trovate: ${rows.length}, attese: 3)`);
  // la riga del file di testo deve avere l'icona "modifica" cablata
  const editIcon = win.document.querySelector('#rows .ti-edit');
  if (editIcon && typeof editIcon.onclick === 'function') ok('icona modifica nota cablata');
  else bad('icona modifica nota NON cablata');

  // i pulsanti chiave hanno un handler?
  const must = ['btnRefresh', 'btnShares', 'btnZipCurrent']
    .concat(canWrite ? ['btnUpload', 'btnUploadFolder', 'btnNewFolder', 'btnNewNote'] : [])
    .concat(isAdmin ? ['btnAdmin'] : []);
  for (const id of must) {
    const el = win.document.getElementById(id);
    if (el && typeof el.onclick === 'function') ok(`#${id} ha un handler onclick`);
    else bad(`#${id} SENZA handler onclick`);
  }
}

console.log('=== JS smoke test (jsdom) ===');
// Verifica del pannello Amministrazione → Utenti con quota e consumo.
async function runAdmin() {
  console.log('\nCaso: pannello Amministrazione (quota + consumo)');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.confirm = () => true;
  const responses = {
    list: listResponse,
    users_list: { ok: true, users: [
      { username: 'admin', role: 'admin', permission: 'write', quota_bytes: 0, quota_mb: 0 },
      { username: 'mario', role: 'user', permission: 'write', quota_bytes: 104857600, quota_mb: 100 },
    ] },
    usage_list: { ok: true, is_s3: true, users: [
      { username: 'admin', usage: 5000, usage_h: '4.9 KB', quota: 0, quota_h: 'illimitata', pct: null, stale: false },
      { username: 'mario', usage: 52428800, usage_h: '50.0 MB', quota: 104857600, quota_h: '100.0 MB', pct: 50, stale: false },
    ] },
  };
  win.fetch = async (url) => {
    const action = (String(url).match(/action=([a-z_]+)/) || [])[1] || 'list';
    const body = responses[action] || { ok: true };
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  win.document.getElementById('btnAdmin').onclick();          // apre il pannello (sezione Utenti)
  await new Promise(r => setTimeout(r, 60));
  if (loadError) { bad(`errore nel pannello admin: ${loadError.message}`); return; }
  const doc = win.document;
  const headers = [...doc.querySelectorAll('.utable th')].map(t => t.textContent.trim());
  headers.includes('Spazio') ? ok('colonna "Spazio" presente') : bad(`colonna "Spazio" assente (${headers.join(',')})`);
  const bar = doc.querySelector('.utable .quota-bar > .q-amber, .utable .quota-bar > .q-green, .utable .quota-bar > .q-red');
  bar ? ok('barra quota renderizzata') : bad('barra quota assente');
  const txt = [...doc.querySelectorAll('.quota-txt')].some(e => /50\.0 MB \/ 100\.0 MB \(50%\)/.test(e.textContent));
  txt ? ok('consumo/quota mostrato (50%)') : bad('testo consumo/quota errato');
  const illim = [...doc.querySelectorAll('.uspace')].some(e => /illimitata/.test(e.textContent));
  illim ? ok('utente senza quota mostrato "illimitata"') : bad('"illimitata" non mostrato');
  const refresh = doc.querySelector('.utable [data-refresh]');
  refresh && typeof refresh.onclick === 'function' ? ok('bottone "Aggiorna spazio" cablato') : bad('refresh non cablato');
  doc.querySelector('.utable [data-u="mario"]').onclick();    // apre il form utente
  await new Promise(r => setTimeout(r, 20));
  const qin = doc.getElementById('u_quota');
  qin && qin.value === '100' ? ok('form utente: quota precompilata (100 MB)') : bad(`form quota errata (${qin && qin.value})`);
}

// Verifica del flusso ZIP client-side (download diretto da S3) con manifest mockato.
async function runClientZip() {
  console.log('\nCaso: ZIP client-side (manifest mode:client, JSZip stubbato)');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  if (!win.crypto) win.crypto = {};
  if (!win.crypto.subtle) win.crypto.subtle = { digest: async () => new Uint8Array(32).buffer };
  // Stub JSZip: registra i file aggiunti, genera un blob fittizio.
  let added = [];
  win.JSZip = function () {
    return {
      file: (name, _data, _opts) => { added.push(name); },
      folder: (name) => { added.push(name + '/'); },
      generateAsync: async () => new win.Blob(['PK'], { type: 'application/zip' }),
    };
  };
  // Stub di URL.createObjectURL / revokeObjectURL (assenti in jsdom).
  win.URL.createObjectURL = () => 'blob:stub';
  win.URL.revokeObjectURL = () => {};
  const manifest = { ok: true, mode: 'client', zipname: 'cartella.zip', total: 4, count: 1,
    files: [{ name: 'docs/a.txt', url: 'https://desotech-desoshare.s3.eu-south-1.wasabisys.com/x?sig=1', size: 4 }] };
  let fetchedPresigned = false;
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes('action=zip_manifest')) return { ok: true, json: async () => manifest, text: async () => JSON.stringify(manifest) };
    if (u.includes('wasabisys.com')) { fetchedPresigned = true; return { ok: true, blob: async () => new win.Blob(['data']) }; }
    return { ok: true, json: async () => listResponse, text: async () => JSON.stringify(listResponse) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  win.document.getElementById('btnZipCurrent').onclick();   // avvia lo ZIP
  await new Promise(r => setTimeout(r, 60));
  if (loadError) { bad(`client-zip ha lanciato un errore: ${loadError.message}`); return; }
  ok('client-zip non lancia eccezioni');
  fetchedPresigned ? ok('file scaricato dall\'URL presigned (Wasabi)') : bad('URL presigned non richiesto');
  added.includes('docs/a.txt') ? ok('file aggiunto allo ZIP client-side') : bad(`file non aggiunto (${added.join(',')})`);
}

// Verifica della sezione SSO/OIDC nel pannello Impostazioni.
async function runOidcSettings() {
  console.log('\nCaso: Impostazioni → SSO/OpenID Connect');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const settings = {
    ok: true, site_title: 'Share', note_poll_ms: 1500, note_max_bytes: 2097152, default_quota_bytes: 0,
    storage: { backend: 'local' },
    oidc: { enabled: true, from_env: false, has_secret: true, client_id: 'CID123',
      issuer: 'https://idp.example/', authz: 'https://idp.example/auth', token: 'https://idp.example/token',
      userinfo: 'https://idp.example/ui', jwks: 'https://idp.example/jwks', endsession: 'https://idp.example/end',
      redirect: 'https://share.deso.tech/index.php?action=oidc_callback', scopes: 'openid email profile',
      admin_group: 'desoshare-admins', rw_group: 'desoshare-readwrite' },
  };
  const responses = {
    settings_get: settings, list: listResponse,
    users_list: { ok: true, users: [{ username: 'admin', role: 'admin', permission: 'write', quota_bytes: 0, quota_mb: 0 }] },
    usage_list: { ok: true, is_s3: false, users: [{ username: 'admin', usage: 0, usage_h: '0 B', quota: 0, quota_h: 'illimitata', pct: null, stale: false }] },
  };
  win.fetch = async (url) => {
    const action = (String(url).match(/action=([a-z_]+)/) || [])[1] || 'list';
    const body = responses[action] || { ok: true };
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  win.document.getElementById('btnAdmin').onclick();
  await new Promise(r => setTimeout(r, 40));
  win.document.querySelector('[data-sec="settings"]').onclick();   // tab Impostazioni
  await new Promise(r => setTimeout(r, 40));
  if (loadError) { bad(`Impostazioni SSO: errore ${loadError.message}`); return; }
  const doc = win.document;
  // Sotto-sezioni: Generale / Archiviazione / Autenticazione
  const subTabs = [...doc.querySelectorAll('.set-tabs button')].map(b => b.textContent.trim());
  (subTabs.length === 3 && /Generale/.test(subTabs[0]) && /Archiviazione/.test(subTabs[1]) && /Autenticazione/.test(subTabs[2]))
    ? ok('sotto-sezioni Generale/Archiviazione/Autenticazione presenti') : bad(`sotto-sezioni errate (${subTabs.join('|')})`);
  // di default è visibile "Generale", lo storage e l'auth sono nascosti
  const authPaneHidden = doc.querySelector('.set-pane[data-pane="auth"]').hidden;
  authPaneHidden ? ok('pannello Autenticazione nascosto di default') : bad('pannello Autenticazione non nascosto');
  doc.querySelector('.set-tabs button[data-pane="auth"]').onclick();   // apre Autenticazione
  await new Promise(r => setTimeout(r, 10));
  !doc.querySelector('.set-pane[data-pane="auth"]').hidden ? ok('click su Autenticazione mostra il pannello') : bad('pannello Autenticazione non mostrato');
  const la = doc.getElementById('local_auth_enabled');
  la && la.checked ? ok('toggle "Autenticazione locale" presente e attivo') : bad('toggle auth locale mancante');
  const tog = doc.getElementById('oidc_enabled');
  tog && tog.checked ? ok('toggle "Abilita SSO" presente e attivo') : bad('toggle SSO mancante/spento');
  const iss = doc.getElementById('oidc_issuer');
  iss && iss.value === 'https://idp.example/' ? ok('Issuer precompilato') : bad(`Issuer errato (${iss && iss.value})`);
  const cid = doc.getElementById('oidc_client_id');
  cid && cid.value === 'CID123' ? ok('Client ID precompilato') : bad('Client ID errato');
  const sec = doc.getElementById('oidc_secret');
  sec && sec.type === 'password' && /invariato/.test(sec.placeholder) ? ok('Secret: campo password, placeholder "invariato"') : bad('campo secret errato');
  const disco = doc.getElementById('oidc_disco');
  disco && typeof disco.onclick === 'function' ? ok('bottone Discovery cablato') : bad('Discovery non cablato');
  const grp = doc.getElementById('oidc_admin_group');
  grp && grp.value === 'desoshare-admins' ? ok('Gruppo admin precompilato') : bad('Gruppo admin errato');
  // i campi OIDC sono disposti su griglia a 2 colonne
  const grid = doc.querySelector('#oidc_box .grid2');
  (grid && grid.querySelector('#oidc_token') && grid.querySelector('#oidc_redirect'))
    ? ok('campi OIDC in griglia a 2 colonne') : bad('campi OIDC non in griglia');
}

console.log('=== JS smoke test (jsdom) ===');
await run('admin (lettura+scrittura)', true, true);
await run('utente sola lettura', false, false);
await runAdmin();
await runClientZip();
await runOidcSettings();

console.log(`\n${failures === 0 ? 'TUTTI I TEST JS PASSATI ✓' : failures + ' TEST JS FALLITI ✗'}`);
process.exit(failures === 0 ? 0 : 1);
