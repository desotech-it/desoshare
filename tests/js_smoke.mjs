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
  // campi principali in griglia a 2 colonne (client id + gruppo admin)
  const grid = doc.querySelector('#oidc_box .grid2');
  (grid && grid.querySelector('#oidc_client_id') && grid.querySelector('#oidc_admin_group'))
    ? ok('campi principali in griglia a 2 colonne') : bad('campi principali non in griglia');
  // endpoint avanzati in una sezione richiudibile <details>
  const adv = doc.querySelector('#oidc_box details.adv');
  (adv && adv.querySelector('#oidc_token') && adv.querySelector('#oidc_redirect'))
    ? ok('endpoint avanzati in sezione richiudibile') : bad('sezione endpoint avanzati assente');
  // pulsante "Prova SSO" cablato
  const tbtn = doc.getElementById('oidc_testbtn');
  tbtn && typeof tbtn.onclick === 'function' ? ok('pulsante "Prova SSO" cablato') : bad('pulsante Prova SSO non cablato');
  // Salva e Chiudi nello STESSO footer .modal-actions (fuori dallo scroll), non dentro #adm_body
  const actions = doc.querySelector('.admin-modal .modal-actions');
  const saveInFooter = actions && actions.querySelector('#adm_save') && typeof doc.getElementById('adm_save').onclick === 'function';
  const noSaveInBody = !doc.querySelector('#adm_body #adm_save') && !doc.querySelector('#adm_body #set_save');
  (saveInFooter && noSaveInBody) ? ok('Salva e Chiudi nel footer unico (fuori dallo scroll)') : bad('barra azioni non unificata');
  // visibile nella tab Impostazioni
  const sv = doc.getElementById('adm_save');
  (sv && !sv.hidden) ? ok('Salva visibile nella tab Impostazioni') : bad('Salva non visibile in Impostazioni');
}

// Creazione nota: il doppio click/Enter NON deve generare un secondo 'newfile' (falso "esiste già")
async function runNoteGuard() {
  console.log('\nCaso: creazione nota — anti doppio-submit');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  let newfileCalls = 0;
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes('action=newfile')) { newfileCalls++; await new Promise(r => setTimeout(r, 25)); return { ok: true, json: async () => ({ ok: true }) }; }
    if (u.includes('action=note_open')) return { ok: true, json: async () => ({ ok: true, id: 'x', name: 'appunti.md', editable: true, text: '', updates: [], offset: 0, poll_ms: 1500 }) };
    return { ok: true, json: async () => listResponse, text: async () => JSON.stringify(listResponse) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  win.document.getElementById('btnNewNote').onclick();    // apre il dialog "Nuova nota"
  await new Promise(r => setTimeout(r, 10));
  win.document.getElementById('nn_name').value = 'appunti';
  const okBtn = win.document.getElementById('nn_ok');
  okBtn.onclick(); okBtn.onclick();                       // doppio click rapido
  await new Promise(r => setTimeout(r, 80));
  newfileCalls === 1 ? ok('doppio click → una sola creazione (guard)') : bad(`newfile chiamato ${newfileCalls} volte (atteso 1)`);
  loadError ? bad('errore nel flusso nota: ' + loadError.message) : ok('nessun errore nel flusso nota');
}

// Pannello Condivisioni: il countdown usa lo stato condiviso `shareTimer`,
// che closeModal() DEVE fermare (clearInterval). Hotspot per lo split app.js.
async function runShares() {
  console.log('\nCaso: pannello Condivisioni — countdown (shareTimer)');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.confirm = () => true;
  let siCount = 0, ciCount = 0;            // spy su setInterval/clearInterval (solo shareTimer li usa)
  win.setInterval = () => { siCount++; return 777; };
  win.clearInterval = (id) => { if (id === 777) ciCount++; };
  const exp = Math.floor(Date.now() / 1000) + 3600;   // scade tra 1 ora
  const responses = {
    list: listResponse,
    share_list: { ok: true, is_admin: true, shares: [
      { name: 'documenti', type: 'dir', mode: 'view', token: 'tok1',
        url: 'https://share.deso.tech/s/tok1', created_by: 'admin', expires_at: exp },
      { name: 'nota.md', type: 'file', mode: 'edit', token: 'tok2',
        url: 'https://share.deso.tech/s/tok2', created_by: 'admin', expires_at: exp },
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
  win.document.getElementById('btnShares').onclick();   // apre il pannello condivisioni
  await new Promise(r => setTimeout(r, 30));
  if (loadError) { bad(`pannello condivisioni: errore ${loadError.message}`); return; }
  const doc = win.document;
  const rows = doc.querySelectorAll('#modalBg tr[data-exp]');
  rows.length === 2 ? ok(`condivisioni elencate (${rows.length} righe)`) : bad(`righe condivisioni errate (${rows.length}, attese 2)`);
  const rem = [...doc.querySelectorAll('#modalBg .sh-rem')].length === 2 &&
    [...doc.querySelectorAll('#modalBg .sh-rem')].every(c => /tra\s/.test(c.textContent));
  rem ? ok('countdown popolato in ogni riga (tick sincrono)') : bad('countdown non popolato');
  siCount >= 1 ? ok('shareTimer avviato (setInterval)') : bad('shareTimer non avviato');
  const copy = doc.querySelector('#modalBg [data-url]');
  copy && typeof copy.onclick === 'function' ? ok('icona copia link cablata') : bad('copia link non cablata');
  const rev = doc.querySelector('#modalBg [data-revoke]');
  rev && typeof rev.onclick === 'function' ? ok('icona revoca cablata') : bad('revoca non cablata');
  win.closeModal();   // chiusura → deve fermare il timer (stato condiviso shareTimer)
  ciCount >= 1 ? ok('closeModal ferma il timer (clearInterval)') : bad('timer non fermato alla chiusura');
}

// Editor note: openEditor monta il bundle e salva la funzione di cleanup in
// `editorCleanup`, che closeModal() DEVE invocare (stop sync/save). Hotspot split.
async function runEditor() {
  console.log('\nCaso: editor note — mount + cleanup (editorCleanup)');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  let mounted = 0, cleaned = 0;
  win.NoteEditor = {
    loadBundle: async () => ({ ok: true }),          // bundle "caricato"
    mount: () => { mounted++; return () => { cleaned++; }; },
  };
  const noteOpen = { ok: true, id: 'x', name: 'nota.md', editable: true, text: '', updates: [], offset: 0, poll_ms: 1500 };
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes('action=note_open')) return { ok: true, json: async () => noteOpen, text: async () => JSON.stringify(noteOpen) };
    return { ok: true, json: async () => listResponse, text: async () => JSON.stringify(listResponse) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  win.document.querySelector('#rows .ti-edit').onclick();   // apre la nota nell'editor
  await new Promise(r => setTimeout(r, 40));
  if (loadError) { bad(`editor: errore ${loadError.message}`); return; }
  mounted === 1 ? ok('NoteEditor.mount invocato (editor montato)') : bad(`mount invocato ${mounted} volte (atteso 1)`);
  cleaned === 0 ? ok('cleanup non ancora invocato (editor aperto)') : bad('cleanup invocato troppo presto');
  win.closeModal();   // chiusura → editorCleanup() deve essere chiamato esattamente una volta
  cleaned === 1 ? ok('closeModal chiama editorCleanup (stop sync/save)') : bad(`cleanup invocato ${cleaned} volte (atteso 1)`);
}

// Filtro di ricerca: searchEl.oninput=renderRows filtra `items` (stato condiviso).
async function runSearch() {
  console.log('\nCaso: filtro di ricerca');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.fetch = async () => ({ ok: true, json: async () => listResponse, text: async () => JSON.stringify(listResponse) });
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  if (loadError) { bad(`ricerca: errore ${loadError.message}`); return; }
  const doc = win.document;
  const search = doc.getElementById('search');
  search.value = 'foto';
  search.dispatchEvent(new win.Event('input'));
  const shown = doc.querySelectorAll('#rows .row');
  (shown.length === 1 && /foto\.jpg/.test(shown[0].textContent)) ? ok('ricerca filtra le righe (1 match: foto.jpg)') : bad(`filtro errato (${shown.length} righe)`);
  search.value = '';
  search.dispatchEvent(new win.Event('input'));
  doc.querySelectorAll('#rows .row').length === 3 ? ok('ricerca svuotata ripristina tutte le righe') : bad('ripristino filtro errato');
}

// Wiring upload: btnUpload→fileInput.click, fileInput.onchange→uploadItems (legge cwd).
async function runUpload() {
  console.log('\nCaso: wiring upload — fileInput → uploadItems');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  if (!win.crypto) win.crypto = {};
  if (!win.crypto.subtle) win.crypto.subtle = { digest: async () => new Uint8Array(32).buffer };
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: false }), text: async () => '{}' });
  win.onerror = () => {};
  win.addEventListener('unhandledrejection', () => {});   // l'upload reale (XHR) non gira in jsdom: ignora
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  const doc = win.document;
  let clicked = false;
  doc.getElementById('fileInput').click = () => { clicked = true; };
  doc.getElementById('btnUpload').onclick();
  clicked ? ok('btnUpload apre il selettore file (fileInput.click)') : bad('btnUpload non collega fileInput');
  // onchange del fileInput deve avviare uploadItems (modale "Caricamento")
  const fakeFile = { name: 'test.txt', size: 5, lastModified: 0, slice: () => new win.Blob(['hello']) };
  doc.getElementById('fileInput').onchange({ target: { files: [fakeFile], value: '' } });
  await new Promise(r => setTimeout(r, 10));
  const title = doc.querySelector('#modalBg h3');
  (title && /Caricamento/.test(title.textContent)) ? ok('onchange avvia uploadItems (modale Caricamento)') : bad('uploadItems non avviato');
  const list = doc.querySelector('#modalBg #up_list');
  (list && /test\.txt/.test(list.textContent)) ? ok('file in coda mostrato (test.txt)') : bad('file non in coda');
}

// Azioni di riga: rinomina e elimina devono inviare i POST corretti (path/from/to).
async function runRowActions() {
  console.log('\nCaso: azioni riga — rinomina + elimina (POST corretti)');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.confirm = () => true;
  let lastPost = null;
  win.fetch = async (url, opts) => {
    const action = (String(url).match(/action=([a-z_]+)/) || [])[1] || 'list';
    if (opts && opts.method === 'POST' && opts.body && opts.body.forEach) {
      const data = {}; opts.body.forEach((v, k) => { data[k] = v; });
      lastPost = { action, data };
    }
    const body = action === 'rename' ? { ok: true }
      : action === 'delete' ? { ok: true, deleted: 1 } : listResponse;
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  const doc = win.document;
  const rows = doc.querySelectorAll('#rows .row');
  rows[1].querySelector('.ti-pencil').onclick();        // rinomina foto.jpg
  await new Promise(r => setTimeout(r, 10));
  doc.getElementById('m_input').value = 'foto2.jpg';
  doc.getElementById('m_ok').onclick();
  await new Promise(r => setTimeout(r, 20));
  (lastPost && lastPost.action === 'rename' && lastPost.data.from === 'foto.jpg' && lastPost.data.to === 'foto2.jpg')
    ? ok('rinomina → POST rename {from,to} corretto') : bad(`rename POST errato (${JSON.stringify(lastPost)})`);
  rows[2].querySelector('.ti-trash').onclick();         // elimina nota.md
  await new Promise(r => setTimeout(r, 10));
  doc.getElementById('d_ok').onclick();
  await new Promise(r => setTimeout(r, 20));
  (lastPost && lastPost.action === 'delete' && /nota\.md/.test(lastPost.data.paths))
    ? ok('elimina → POST delete {paths} corretto') : bad(`delete POST errato (${JSON.stringify(lastPost)})`);
  loadError ? bad('errore azioni riga: ' + loadError.message) : ok('nessun errore nelle azioni riga');
}

// Impostazioni → Salva: il footer unico invia settings_save con i campi attesi.
async function runSettingsSave() {
  console.log('\nCaso: Impostazioni → salvataggio (POST settings_save)');
  const dom = new JSDOM(pageHtml(true, true), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const settings = {
    ok: true, site_title: 'Share', note_poll_ms: 1500, note_max_bytes: 2097152, default_quota_bytes: 0,
    storage: { backend: 'local' },
    oidc: { enabled: false, from_env: false, has_secret: false, client_id: '', issuer: '', authz: '', token: '',
      userinfo: '', jwks: '', endsession: '', redirect: '', scopes: 'openid email profile', admin_group: '', rw_group: '' },
  };
  let lastPost = null;
  const responses = {
    settings_get: settings, list: listResponse, settings_save: { ok: true },
    users_list: { ok: true, users: [{ username: 'admin', role: 'admin', permission: 'write', quota_bytes: 0, quota_mb: 0 }] },
    usage_list: { ok: true, is_s3: false, users: [{ username: 'admin', usage: 0, usage_h: '0 B', quota: 0, quota_h: 'illimitata', pct: null, stale: false }] },
  };
  win.fetch = async (url, opts) => {
    const action = (String(url).match(/action=([a-z_]+)/) || [])[1] || 'list';
    if (opts && opts.method === 'POST' && opts.body && opts.body.forEach) {
      const data = {}; opts.body.forEach((v, k) => { data[k] = v; });
      lastPost = { action, data };
    }
    const body = responses[action] || { ok: true };
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  let loadError = null;
  win.onerror = (m, s, l, c, e) => { loadError = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { loadError = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  const doc = win.document;
  doc.getElementById('btnAdmin').onclick();
  await new Promise(r => setTimeout(r, 40));
  doc.querySelector('[data-sec="settings"]').onclick();   // tab Impostazioni → renderSettingsSection cabla adm_save
  await new Promise(r => setTimeout(r, 40));
  doc.getElementById('set_title').value = 'Nuovo Titolo';
  doc.getElementById('adm_save').onclick();
  await new Promise(r => setTimeout(r, 20));
  if (loadError) { bad('errore settings save: ' + loadError.message); return; }
  (lastPost && lastPost.action === 'settings_save' && lastPost.data.site_title === 'Nuovo Titolo')
    ? ok('settings_save invia site_title aggiornato') : bad(`settings_save POST errato (${JSON.stringify(lastPost && lastPost.data)})`);
  (lastPost && 'local_auth_enabled' in lastPost.data)
    ? ok('payload include local_auth_enabled') : bad('payload manca local_auth_enabled');
}

// Ambiente jsdom per i test di condivisioni e cestino: `respond(action, data)` dà
// la risposta JSON; registra GET e POST (con i campi del FormData) e gli errori.
async function shareEnv(canWrite, isAdmin, respond) {
  const dom = new JSDOM(pageHtml(canWrite, isAdmin), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://share.deso.tech/' });
  const win = dom.window;
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  win.setInterval = () => 0; win.clearInterval = () => {};   // countdown: niente timer veri
  const env = { win, doc: win.document, gets: [], posts: [], confirms: [], confirmAnswer: true, error: null };
  win.confirm = (m) => { env.confirms.push(m); return env.confirmAnswer; };
  win.fetch = async (url, opts) => {
    const action = (String(url).match(/action=([a-z_]+)/) || [])[1] || 'list';
    let data = null;
    if (opts && opts.method === 'POST' && opts.body && opts.body.forEach) {
      data = {}; opts.body.forEach((v, k) => { data[k] = v; });
      env.posts.push({ action, data });
    } else env.gets.push(action);
    const body = (action === 'list' ? listResponse : respond(action, data)) || { ok: true };
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  win.onerror = (m, s, l, c, e) => { env.error = e || new Error(m); };
  win.addEventListener('unhandledrejection', (e) => { env.error = e.reason; });
  win.eval(appJs);
  await new Promise(r => setTimeout(r, 30));
  env.lastPost = (a) => [...env.posts].reverse().find(p => p.action === a);
  env.toasts = () => [...env.doc.querySelectorAll('.toast')].map(t => t.textContent);
  env.wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
  return env;
}
const rowShare = (env, i) => env.doc.querySelectorAll('#rows .row')[i].querySelector('.ti-share').onclick();

// Dialog «Condividi» di un file non modificabile: niente select di livello,
// parte leggibile precompilata e anteprima con data/ora e codice, label e PIN inviati.
async function runShareCreate() {
  console.log('\nCaso: dialog Condividi — file (indirizzo, destinatario, PIN)');
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const env = await shareEnv(true, true, (action, data) => {
    if (action !== 'share_create') return null;
    if (data.slug === 'errore') return { ok: false, error: 'PIN non valido: da 4 a 64 caratteri' };
    return { ok: true, token: 'abc', slug: 'mia-foto-20261011-1430-k7q2xm', url: 'https://share.deso.tech/d/mia-foto-20261011-1430-k7q2xm',
      expires_at: exp, mode: 'view', label: data.label, has_pin: data.pin !== '' };
  });
  const { doc } = env;
  rowShare(env, 1);                                                             // foto.jpg
  await env.wait(10);
  const slugEl = doc.getElementById('sh_slug');
  (slugEl && slugEl.value === 'foto') ? ok('parte leggibile precompilata col nome senza estensione (foto)') : bad(`slug precompilato errato (${slugEl && slugEl.value})`);
  const hint = doc.getElementById('sh_slughint');
  (hint && /→ https:\/\/share\.deso\.tech\/d\/foto-\d{8}-\d{4}-xxxxxx$/.test(hint.textContent))
    ? ok('anteprima /d/foto-AAAAMMGG-HHMM-xxxxxx') : bad(`anteprima errata (${hint && hint.textContent})`);
  /aggiunti automaticamente/.test(doc.querySelector('#modalBg .sh-modal').textContent)
    ? ok('nota: data, ora e codice aggiunti automaticamente') : bad('manca la nota sul suffisso automatico');
  slugEl.value = ''; slugEl.oninput();
  /\/d\/foto-\d{8}-\d{4}-xxxxxx$/.test(hint.textContent) ? ok('campo vuoto: anteprima col nome predefinito') : bad(`anteprima a campo vuoto: ${hint.textContent}`);
  !doc.getElementById('sh_mode') && /Sola lettura/.test(doc.querySelector('.sh-fixed') ? doc.querySelector('.sh-fixed').textContent : '')
    ? ok('file non di testo: solo «Sola lettura», nessun select') : bad('file non di testo: select di livello presente');
  const label = doc.getElementById('sh_label'), pin = doc.getElementById('sh_pin');
  (label && label.maxLength === 80 && label.placeholder === 'es. Avv. Bianchi' && doc.activeElement === label)
    ? ok('campo «A chi lo dai» (max 80, segnaposto, con il fuoco)') : bad('campo destinatario errato');
  (pin && pin.type === 'text' && pin.getAttribute('autocomplete') === 'off' && /Comunicalo a parte/.test(doc.querySelector('#modalBg').textContent))
    ? ok('campo PIN testo, autocomplete=off, con la nota') : bad('campo PIN errato');
  // PIN troppo corto: errore locale, nessun POST
  pin.value = '123';
  doc.getElementById('sh_create').onclick();
  await env.wait();
  const err = doc.getElementById('sh_err');
  (!env.lastPost('share_create') && err && !err.hidden && /almeno 4/.test(err.textContent))
    ? ok('PIN di 3 caratteri: errore senza chiamare il server') : bad(`PIN corto: post=${!!env.lastPost('share_create')}, err=${err && err.textContent}`);
  // errore del server: mostrato, «Crea link» resta attivo
  slugEl.value = 'errore'; pin.value = '1234';
  doc.getElementById('sh_create').onclick();
  await env.wait();
  const btnAfterErr = doc.getElementById('sh_create');
  (btnAfterErr && !btnAfterErr.disabled && /PIN non valido/.test(err.textContent) && !err.hidden && !doc.getElementById('sh_url'))
    ? ok('errore del server mostrato, «Crea link» resta attivo') : bad(`dopo errore: bottone=${btnAfterErr && !btnAfterErr.disabled}, err=${err.textContent}`);
  slugEl.value = 'mia-foto'; slugEl.oninput();
  label.value = '  Avv. <b>Bianchi</b> '; pin.value = ' s3gr3t0 ';
  doc.getElementById('sh_create').onclick();
  await env.wait();
  if (env.error) { bad('errore share-create: ' + env.error.message); return; }
  const p = env.lastPost('share_create');
  (p && p.data.path === 'foto.jpg' && p.data.ttl === '86400' && p.data.mode === 'view' && p.data.slug === 'mia-foto'
    && p.data.label === 'Avv. <b>Bianchi</b>' && p.data.pin === 's3gr3t0' && p.data.upload_limit_mb === '')
    ? ok('share_create invia path, ttl, mode, slug, label e pin (ripuliti)') : bad(`POST errato: ${JSON.stringify(p && p.data)}`);
  const fieldsOff = ['sh_ttl', 'sh_slug', 'sh_label', 'sh_pin'].every(id => doc.getElementById(id).disabled);
  const closeBtn = doc.querySelector('#modalBg .modal-actions .btn');
  (!doc.getElementById('sh_create') && fieldsOff && closeBtn && closeBtn.classList.contains('btn-primary') && /Chiudi/.test(closeBtn.textContent))
    ? ok('dopo la creazione resta solo «Chiudi» e i campi sono bloccati') : bad(`dopo creazione: crea=${!!doc.getElementById('sh_create')}, campi bloccati=${fieldsOff}`);
  const urlEl = doc.getElementById('sh_url');
  (urlEl && urlEl.value === 'https://share.deso.tech/d/mia-foto-20261011-1430-k7q2xm' && typeof doc.getElementById('sh_copy').onclick === 'function')
    ? ok('risultato: URL completo con pulsante copia') : bad(`URL risultato errato (${urlEl && urlEl.value})`);
  const res = doc.getElementById('sh_result');
  (/Livello\s*Sola lettura/.test(res.textContent) && /Destinatario\s*Avv\. <b>Bianchi<\/b>/.test(res.textContent) && !res.querySelector('b') && /Scade/.test(res.textContent))
    ? ok('riepilogo: livello, destinatario (con escape) e scadenza') : bad(`riepilogo errato: ${res.textContent.replace(/\s+/g, ' ')}`);
  (/PIN impostato: comunicalo separatamente/.test(res.textContent) && !res.innerHTML.includes('s3gr3t0'))
    ? ok('«PIN impostato» senza ripetere il PIN') : bad('avviso PIN assente o PIN ripetuto nel riepilogo');
}

// Dialog «Condividi» di una cartella: 4 livelli con spiegazione, tetto solo per i
// livelli che caricano; mode e upload_limit_mb inviati. Nota: 2 livelli. Sola lettura: nessuno.
async function runShareCreateDir() {
  console.log('\nCaso: dialog Condividi — cartella (4 livelli, tetto) e nota');
  const exp = Math.floor(Date.now() / 1000) + 604800;
  const env = await shareEnv(true, false, (action, data) => action === 'share_create'
    ? { ok: true, token: 't', slug: 'documenti-20261011-1430-abcdef', url: 'https://share.deso.tech/d/documenti-20261011-1430-abcdef',
        expires_at: exp, mode: data.mode, label: data.label, has_pin: false } : null);
  const { doc } = env;
  rowShare(env, 0);                                                             // documenti/
  await env.wait(10);
  const mode = doc.getElementById('sh_mode');
  const vals = mode ? [...mode.options].map(o => o.value).join(',') : '';
  const names = mode ? [...mode.options].map(o => o.textContent).join(' / ') : '';
  (vals === 'view,edit,contrib,manage' && names === 'Sola lettura / Caricamento / Collaboratore / Gestione completa')
    ? ok('cartella: 4 livelli (' + names + ')') : bad(`livelli errati: ${vals} (${names})`);
  (doc.getElementById('sh_slug').value === 'documenti') ? ok('parte leggibile = nome della cartella') : bad('slug cartella errato');
  const help = doc.getElementById('sh_mode_help'), wrap = doc.getElementById('sh_limit_wrap');
  const seen = {};
  for (const v of ['view', 'edit', 'contrib', 'manage']) {
    mode.value = v; mode.onchange();
    seen[v] = { help: help.textContent, cap: !wrap.hidden };
  }
  (new Set(Object.values(seen).map(x => x.help)).size === 4 && Object.values(seen).every(x => x.help.length > 10) && /cestino/.test(seen.manage.help))
    ? ok('spiegazione diversa per ogni livello') : bad(`spiegazioni: ${JSON.stringify(seen)}`);
  (!seen.view.cap && seen.edit.cap && seen.contrib.cap && seen.manage.cap)
    ? ok('tetto visibile solo per Caricamento/Collaboratore/Gestione completa') : bad(`tetto: ${JSON.stringify(seen)}`);
  mode.value = 'manage'; mode.onchange();
  doc.getElementById('sh_limit').value = '500';
  doc.getElementById('sh_ttl').value = '604800';
  doc.getElementById('sh_label').value = 'Studio Rossi';
  doc.getElementById('sh_create').onclick();
  await env.wait();
  let p = env.lastPost('share_create');
  (p && p.data.path === 'documenti' && p.data.mode === 'manage' && p.data.upload_limit_mb === '500' && p.data.ttl === '604800'
    && p.data.label === 'Studio Rossi' && p.data.pin === '' && p.data.slug === 'documenti')
    ? ok('share_create: mode=manage, tetto 500, label, pin vuoto') : bad(`POST cartella errato: ${JSON.stringify(p && p.data)}`);
  const res = doc.getElementById('sh_result').textContent;
  (/Gestione completa · fino a 500\.0 MB/.test(res) && /Studio Rossi/.test(res) && !/PIN impostato/.test(res) && doc.getElementById('sh_mode').disabled && doc.getElementById('sh_limit').disabled)
    ? ok('riepilogo cartella: livello e tetto, nessun avviso PIN, campi bloccati') : bad(`riepilogo cartella: ${res.replace(/\s+/g, ' ')}`);
  // Sola lettura: niente tetto inviato
  env.win.closeModal();
  rowShare(env, 0); await env.wait(10);
  doc.getElementById('sh_create').onclick(); await env.wait();
  p = env.lastPost('share_create');
  (p && p.data.mode === 'view' && p.data.upload_limit_mb === '') ? ok('sola lettura: upload_limit_mb vuoto') : bad(`sola lettura: ${JSON.stringify(p && p.data)}`);
  // Nota di testo: Sola lettura / Modificabile, niente tetto
  env.win.closeModal();
  rowShare(env, 2); await env.wait(10);
  const nm = doc.getElementById('sh_mode');
  (nm && [...nm.options].map(o => o.value).join(',') === 'view,edit' && /co-editing/.test(nm.options[1].textContent) && !doc.getElementById('sh_limit_wrap'))
    ? ok('nota: Sola lettura / Modificabile (co-editing), senza tetto') : bad('livelli della nota errati');
  doc.getElementById('sh_slug').value === 'nota' ? ok('nota: parte leggibile senza estensione') : bad('slug nota errato');
  if (env.error) bad('errore: ' + env.error.message);
  // Utente in sola lettura: nessun livello di scrittura offerto
  const ro = await shareEnv(false, false, () => null);
  rowShare(ro, 0); await ro.wait(10);
  !ro.doc.getElementById('sh_mode') ? ok('utente senza scrittura: cartella solo in sola lettura') : bad('utente senza scrittura: livelli offerti');
}

// Pannello «Condivisioni attive»: destinatario, livello, lucchetto PIN, caricati/tetto,
// livello degradato, pulsante «Cestino (N)».
async function runSharesMeta() {
  console.log('\nCaso: pannello Condivisioni — destinatario, livello, PIN, cestino');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const env = await shareEnv(true, true, (action) => ({
    share_list: { ok: true, is_admin: true, now: Math.floor(Date.now() / 1000), shares: [
      { name: 'patti-temp', type: 'dir', mode: 'manage', level: 'manage', label: 'Avv. Bianchi', has_pin: true, token: 'tok1',
        upload_limit: 1073741824, uploaded: 1048576, url: 'https://share.deso.tech/d/patti-temp-20261011-1430-k7q2xm', created_by: 'nicola', expires_at: exp },
      { name: 'foto', type: 'dir', mode: 'contrib', level: 'view', label: '<img src=x onerror=alert(1)>', has_pin: false, token: 'tok2',
        upload_limit: 0, uploaded: 0, url: 'https://share.deso.tech/d/foto-x', created_by: 'nicola', expires_at: exp },
      { name: 'nota.md', type: 'file', mode: 'edit', level: 'edit', label: '', has_pin: false, token: 'tok3',
        upload_limit: 0, uploaded: 0, url: 'https://share.deso.tech/d/nota-x', created_by: 'nicola', expires_at: exp },
    ] },
    trash_list: { ok: true, days: 30, entries: [{ id: 'a' }, { id: 'b' }] },
  })[action]);
  const { doc } = env;
  doc.getElementById('btnShares').onclick();
  await env.wait(30);
  const metas = [...doc.querySelectorAll('#modalBg .sh-meta')];
  const m0 = metas[0] ? metas[0].textContent : '';
  (/per «Avv\. Bianchi»/.test(m0) && /Gestione completa/.test(m0) && metas[0].querySelector('.ti-lock') && /caricati 1\.0 MB \/ 1\.0 GB/.test(m0) && /di nicola/.test(m0))
    ? ok('riga 1: destinatario, livello, lucchetto, caricati/tetto, autore') : bad(`riga 1: ${m0}`);
  const m1 = metas[1] ? metas[1].textContent : '';
  (/per «<img src=x onerror=alert\(1\)>»/.test(m1) && !doc.querySelector('#modalBg img') && /Sola lettura \(era Collaboratore\)/.test(m1)
    && /nessun tetto/.test(m1) && !metas[1].querySelector('.ti-lock'))
    ? ok('riga 2: destinatario con escape, livello degradato, nessun lucchetto') : bad(`riga 2: ${m1}`);
  const m2 = metas[2] ? metas[2].textContent : '';
  (/Modificabile/.test(m2) && !/per «/.test(m2) && !/caricati/.test(m2)) ? ok('riga 3 (nota): Modificabile, senza destinatario né caricati') : bad(`riga 3: ${m2}`);
  const names = [...doc.querySelectorAll('#modalBg .sh-name')].map(n => n.textContent.trim());
  names.join('|') === 'patti-temp|foto|nota.md' ? ok('nome elemento sopra la riga dei dettagli') : bad(`nomi: ${names}`);
  const tb = doc.getElementById('sh_trash');
  (tb && /Cestino \(2\)/.test(tb.textContent) && typeof tb.onclick === 'function') ? ok('pulsante «Cestino (2)» nella barra azioni') : bad(`pulsante cestino: ${tb && tb.textContent}`);
  doc.querySelector('#modalBg [data-revoke="tok1"]').onclick();
  await env.wait();
  const rv = env.lastPost('share_revoke');
  (rv && rv.data.token === 'tok1' && /Avv\. Bianchi/.test(env.confirms[0] || '')) ? ok('revoca: conferma col destinatario e POST del token') : bad('revoca errata');
  if (env.error) bad('errore: ' + env.error.message);
}

// Cestino: elenco con escape, ripristino (toast + ricarica elenco), eliminazione
// definitiva e svuotamento con conferma, stato vuoto.
async function runTrash() {
  console.log('\nCaso: cestino — elenco, ripristina, elimina, svuota');
  const now = Math.floor(Date.now() / 1000);
  let entries = [
    { id: 'e1', name: 'contratto.pdf', type: 'file', size: 2048, orig: 'patti-temp/contratto.pdf', at: now - 3600, by: 'link «Avv. Bianchi»', expires_in: 29 * 86400 },
    { id: 'e2', name: '<img src=x onerror=alert(1)>', type: 'dir', size: 0, orig: 'patti-temp/<b>x</b>', at: now - 60, by: 'link «a&b»', expires_in: 0 },
  ];
  const env = await shareEnv(true, false, (action, data) => {
    if (action === 'share_list') return { ok: true, shares: [], now };
    if (action === 'trash_list') return { ok: true, days: 30, entries };
    if (action === 'trash_restore') return { ok: true, path: 'patti-temp/contratto (2).pdf' };
    if (action === 'trash_purge') { if (data.ids) { const ids = JSON.parse(data.ids); const n = entries.filter(e => ids.includes(e.id)).length; entries = entries.filter(e => !ids.includes(e.id)); return { ok: true, purged: n }; } entries = entries.filter(e => e.id !== data.id); return { ok: true, purged: 1 }; }
    return null;
  });
  const { doc } = env;
  doc.getElementById('btnShares').onclick();
  await env.wait(30);
  doc.getElementById('sh_trash').onclick();
  await env.wait(30);
  const rows = doc.querySelectorAll('#modalBg tr[data-id]');
  const heads = [...doc.querySelectorAll('#modalBg .tr-table th')].map(t => t.textContent.trim()).filter(Boolean).join('|');
  (rows.length === 2 && heads === 'Nome|Eliminato da|Quando|Scade tra|Dimensione') ? ok('cestino: 2 righe, colonne attese') : bad(`cestino: righe=${rows.length}, colonne=${heads}`);
  const r0 = rows[0].textContent;
  (/contratto\.pdf/.test(r0) && /\/patti-temp\/contratto\.pdf/.test(rows[0].querySelector('.tr-orig').textContent) && /link «Avv\. Bianchi»/.test(r0) && /2\.0 KB/.test(r0) && /29g/.test(r0))
    ? ok('riga: nome, percorso d\'origine, eliminato da, scadenza, dimensione') : bad(`riga 1: ${r0.replace(/\s+/g, ' ')}`);
  (!doc.querySelector('#modalBg img') && !doc.querySelector('#modalBg .tr-orig b') && /link «a&b»/.test(rows[1].textContent))
    ? ok('dati del server con escape (nome, percorso, autore)') : bad('escape mancante nel cestino');
  rows[0].querySelector('.tr-restore').onclick();
  await env.wait(40);
  const rs = env.lastPost('trash_restore');
  (rs && rs.data.id === 'e1') ? ok('Ripristina → POST trash_restore id=e1') : bad(`restore: ${JSON.stringify(rs)}`);
  env.toasts().includes('Ripristinato in /patti-temp/contratto (2).pdf') ? ok('toast «Ripristinato in …»') : bad(`toast: ${env.toasts()}`);
  const listsAfter = env.gets.filter(a => a === 'list').length;
  listsAfter >= 2 ? ok('dopo il ripristino l\'elenco corrente viene ricaricato') : bad(`load(S.cwd) non chiamato (list GET: ${listsAfter})`);
  // eliminazione definitiva: con conferma rifiutata non parte nulla
  env.confirmAnswer = false;
  doc.querySelectorAll('#modalBg tr[data-id]')[1].querySelector('.tr-purge').onclick();
  await env.wait();
  !env.lastPost('trash_purge') ? ok('conferma rifiutata: nessuna eliminazione') : bad('purge partito senza conferma');
  env.confirmAnswer = true;
  doc.querySelectorAll('#modalBg tr[data-id]')[1].querySelector('.tr-purge').onclick();
  await env.wait(40);
  const pg = env.lastPost('trash_purge');
  (pg && pg.data.id === 'e2' && !('all' in pg.data) && /definitivamente/.test(env.confirms.at(-1))) ? ok('Elimina definitivamente → POST trash_purge id=e2 (con conferma)') : bad(`purge: ${JSON.stringify(pg)}`);
  doc.querySelectorAll('#modalBg tr[data-id]').length === 1 ? ok('elenco del cestino aggiornato') : bad('cestino non aggiornato dopo purge');
  const shownIds = [...doc.querySelectorAll('#modalBg tr[data-id]')].map(tr => tr.dataset.id);
  doc.getElementById('tr_empty').onclick();
  await env.wait(40);
  const pa = env.lastPost('trash_purge');
  (pa && JSON.stringify(JSON.parse(pa.data.ids || 'null')) === JSON.stringify(shownIds) && !('all' in pa.data) && /Svuotare il cestino/.test(env.confirms.at(-1))) ? ok('Svuota cestino → POST trash_purge con i soli id mostrati (con conferma)') : bad(`svuota: ${JSON.stringify(pa)}`);
  const empty = doc.querySelector('#modalBg .tr-modal');
  (empty && /Il cestino è vuoto\. Qui finiscono per 30 giorni gli elementi eliminati o sostituiti tramite i link\./.test(empty.textContent) && !doc.getElementById('tr_empty'))
    ? ok('cestino vuoto: messaggio con i giorni, niente «Svuota»') : bad(`stato vuoto: ${empty && empty.textContent}`);
  if (env.error) bad('errore: ' + env.error.message);
}

console.log('=== JS smoke test (jsdom) ===');
await run('admin (lettura+scrittura)', true, true);
await run('utente sola lettura', false, false);
await runAdmin();
await runClientZip();
await runOidcSettings();
await runNoteGuard();
await runShares();
await runEditor();
await runSearch();
await runUpload();
await runRowActions();
await runSettingsSave();
await runShareCreate();
await runShareCreateDir();
await runSharesMeta();
await runTrash();

console.log(`\n${failures === 0 ? 'TUTTI I TEST JS PASSATI ✓' : failures + ' TEST JS FALLITI ✗'}`);
process.exit(failures === 0 ? 0 : 1);
