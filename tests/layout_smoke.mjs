// layout_smoke.mjs — layout con barra laterale in un browser VERO (Chromium) contro php -S.
// Verifica: barra laterale a 1920 (voci, utente, quota), riduzione a sole icone con
// scelta ricordata dopo il ricaricamento, fascia di icone in alto a 390 senza overflow,
// pillola «condivisa» e icona «Accessi» solo sugli elementi con un link attivo, pagina
// «Registro» a tutta pagina (filtro precompilato dall'icona Accessi, selettore
// Tutti/Solo i miei per l'admin, assente per l'utente normale, che non vede «Amministrazione»).
// Uso: PATH=/percorso/php:$PATH node tests/layout_smoke.mjs   (atteso "SMOKE LAYOUT OK ✓")
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (_) {
  try { ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright')); } catch (_) { console.error('playwright non disponibile'); process.exit(2); }
}
let failures = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failures++; console.log('  ✗ ' + m); };

const PORT = 8413, B = `http://127.0.0.1:${PORT}`;
const SBX = mkdtempSync(join(tmpdir(), 'shlayout-'));
const PUB = join(SBX, 'public_html');
cpSync(APP, PUB, { recursive: true, filter: s => !/node_modules|\/tests\/|\.git(\/|$)|app-src|editor-src/.test(s) });
const srv = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', PUB], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill(); } catch {} try { rmSync(SBX, { recursive: true, force: true }); } catch {} });
for (let i = 0; ; i++) { try { await fetch(B + '/index.php'); break; } catch { if (i > 50) throw new Error('server non avviato'); await new Promise(r => setTimeout(r, 100)); } }
// Database GeoIP di prova (MaxMind) per la colonna «Da dove»
mkdirSync(join(SBX, 'appdata', 'geoip'), { recursive: true });
copyFileSync(join(APP, 'tests', 'GeoIP2-City-Test.mmdb'), join(SBX, 'appdata', 'geoip', 'city.mmdb'));

// Client HTTP con cookie (setup + dati di prova)
function client() {
  const jar = new Map();
  const req = async (path, opts = {}) => {
    const r = await fetch(B + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const sc of r.headers.getSetCookie?.() || []) { const m = /^([^=]+)=([^;]+)/.exec(sc); if (m) jar.set(m[1], m[2]); }
    return r;
  };
  return { jar, req };
}
const admin = client();
const pre = async c => /name="csrf" value="([^"]+)"/.exec(await (await c.req('/index.php')).text())[1];
await admin.req('/index.php', { method: 'POST', body: new URLSearchParams({ action: 'setup', username: 'admin', password: 'secret123', csrf: await pre(admin) }) });
const CSRF = /data-csrf="([^"]+)"/.exec(await (await admin.req('/')).text())[1];
const api = async (c, csrf, action, data) => { const b = new FormData(); for (const [k, v] of Object.entries(data)) b.append(k, v); return (await c.req('/api.php?action=' + action, { method: 'POST', body: b, headers: { 'X-CSRF': csrf } })).json(); };
await api(admin, CSRF, 'mkdir', { path: '', name: 'Condivisa' });
await api(admin, CSRF, 'mkdir', { path: '', name: 'Privata' });
await api(admin, CSRF, 'newfile', { path: 'Condivisa', name: 'doc.txt', content: 'ciao' });
const share = await api(admin, CSRF, 'share_create', { path: 'Condivisa', ttl: '86400', mode: 'view', label: 'Ospite' });
await admin.req('/api.php?action=download&path=Condivisa/doc.txt');               // un evento nel registro
await fetch(`${B}/share.php?t=${share.slug}`);                                     // visita del link
await api(admin, CSRF, 'user_save', { username: 'lettore', password: 'secret123', permission: 'read', role: 'user' });
const user = client();
await user.req('/index.php', { method: 'POST', body: new URLSearchParams({ action: 'login', username: 'lettore', password: 'secret123', csrf: await pre(user) }) });

const browser = await chromium.launch();
const errs = [];
const cookies = jar => [...jar].map(([name, value]) => ({ name, value, url: B }));
const overflow = p => p.evaluate(() => document.documentElement.scrollWidth > innerWidth);

console.log('\nAdmin, 1920px');
const ctxA = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
await ctxA.addCookies(cookies(admin.jar));
const p = await ctxA.newPage();
p.on('pageerror', e => errs.push(e.message));
await p.goto(B + '/');
await p.waitForSelector('#rows .row');
(await p.$eval('#sb', e => e.getBoundingClientRect().width)) === 240 ? ok('barra laterale da 240px') : bad('larghezza barra laterale errata');
const labels = await p.$$eval('.sb-nav .sb-label', ls => ls.map(l => l.textContent.trim()));
['File', 'Condivisioni', 'Cestino', 'Registro', 'Amministrazione'].every(x => labels.includes(x)) ? ok('voci: File, Condivisioni, Cestino, Registro, Amministrazione') : bad('voci mancanti: ' + labels.join(','));
(await p.textContent('.sb-count')).trim() === '1' ? ok('contatore condivisioni = 1') : bad('contatore condivisioni errato');
(await p.textContent('.avatar')).trim() === 'AD' && /admin/.test(await p.textContent('.sb-user-name')) ? ok('utente e iniziali nel piè della barra') : bad('utente non mostrato');
(await p.$eval('.main', e => e.getBoundingClientRect().width)) > 1500 ? ok('contenuto fluido oltre i 1000px') : bad('contenuto ancora stretto');
!(await overflow(p)) ? ok('1920: nessuno scorrimento orizzontale') : bad('1920: overflow');
// elementi condivisi
const rowOf = async name => p.$(`#rows .row:has(.label[title="${name}"])`);
const rs = await rowOf('Condivisa'), rp = await rowOf('Privata');
(rs && await rs.$('.badge-link') && await rs.$('.ti-acc')) ? ok('«Condivisa»: pillola e icona Accessi') : bad('pillola/icona assenti su Condivisa');
(rp && !(await rp.$('.badge-link')) && !(await rp.$('.ti-acc'))) ? ok('«Privata»: niente pillola né icona') : bad('pillola/icona su Privata');
// riduzione della barra, ricordata
await p.click('#sbToggle');
(await p.$eval('#sb', e => e.getBoundingClientRect().width)) <= 64 ? ok('ridotta a sole icone (≤64px)') : bad('barra non ridotta');
await p.reload(); await p.waitForSelector('#rows .row');
(await p.$eval('#app', e => e.classList.contains('sb-collapsed'))) ? ok('riduzione ricordata dopo il ricaricamento') : bad('riduzione non ricordata');
(await p.$$eval('.sb-nav .sb-label', ls => ls.every(l => getComputedStyle(l).display === 'none'))) ? ok('ridotta: etichette nascoste, icone visibili') : bad('etichette visibili con barra ridotta');
await p.click('#sbToggle');
(await p.$eval('#sb', e => e.getBoundingClientRect().width)) === 240 ? ok('riallargata') : bad('non riallargata');
// icona Accessi → pagina Registro filtrata
await (await rowOf('Condivisa')).$('.ti-acc').then(i => i.click());
await p.waitForSelector('#registro .acc-table');
/view=registro/.test(p.url()) && /path=Condivisa/.test(p.url()) ? ok('icona Accessi → pagina Registro con percorso') : bad('URL del registro: ' + p.url());
(await p.inputValue('#af_path')) === 'Condivisa' ? ok('filtro percorso precompilato') : bad('percorso non precompilato');
(await p.$$('#registro .acc-table tbody tr')).length >= 1 ? ok('eventi dell\'elemento elencati') : bad('nessun evento');
(await p.$$eval('#registro .acc-table thead th', ths => ths.map(t => t.textContent))).includes('Da dove') ? ok('colonna «Da dove» presente') : bad('colonna Da dove assente');
/rete locale/.test(await p.textContent('#registro .acc-table tbody')) ? ok('IP locale mostrato come «rete locale»') : bad('posizione locale non mostrata');
(await p.$eval('.sb-item.active .sb-label', e => e.textContent.trim())) === 'Registro' ? ok('voce Registro attiva nella barra') : bad('voce attiva errata');
(await p.$('#accScope')) ? ok('admin: selettore Tutti / Solo i miei') : bad('selettore assente per l\'admin');
await p.click('#accScope [data-scope="mine"]'); await p.waitForTimeout(400);
(await p.$$('#registro .acc-table tbody tr')).length >= 1 ? ok('«Solo i miei» mostra i propri eventi') : bad('«Solo i miei» vuoto');
!(await p.$('#listing')) && !(await p.$('#btnUpload')) ? ok('pagina Registro senza elenco file né toolbar') : bad('elementi dell\'elenco presenti nel registro');
await p.goto(B + '/?view=registro&token=' + share.token.slice(0, 8)); await p.waitForSelector('#registro .acc-table');
/solo il link/.test(await p.textContent('.acc-fixed')) ? ok('filtro per link indicato con rimando a tutti gli eventi') : bad('indicazione del link assente');
await p.close();

console.log('\nAdmin, 390px');
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctxM.addCookies(cookies(admin.jar));
const m = await ctxM.newPage(); m.on('pageerror', e => errs.push(e.message));
await m.goto(B + '/'); await m.waitForSelector('#rows .row');
!(await overflow(m)) ? ok('390: nessuno scorrimento orizzontale') : bad('390: overflow');
const sb = await m.$eval('#sb', e => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
sb.h <= 60 && sb.w >= 380 ? ok('390: barra come fascia di icone in alto') : bad(`390: barra ${sb.w}x${sb.h}`);
(await m.$eval('#sbToggle', e => getComputedStyle(e).display)) === 'none' ? ok('390: pulsante di riduzione nascosto') : bad('390: pulsante di riduzione visibile');
const acts = await m.$$eval('#rows .row .acts .ti', is => is.map(i => i.getBoundingClientRect().right));
const lst = await m.$eval('#listing', e => e.getBoundingClientRect().right);
acts.every(r => r <= lst) ? ok('390: icone azione dentro l\'elenco (compresa Accessi)') : bad('390: icone fuori dall\'elenco');
await m.close();

console.log('\nUtente normale');
const ctxU = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctxU.addCookies(cookies(user.jar));
const u = await ctxU.newPage(); u.on('pageerror', e => errs.push(e.message));
await u.goto(B + '/'); await u.waitForSelector('#sb');
!(await u.$('#btnAdmin')) ? ok('niente «Amministrazione» per l\'utente') : bad('Amministrazione visibile all\'utente');
!(await u.$('#btnUpload')) ? ok('sola lettura: niente pulsanti di scrittura') : bad('pulsanti di scrittura per utente in sola lettura');
await u.goto(B + '/?view=registro'); await u.waitForSelector('#registro');
!(await u.$('#accScope')) ? ok('utente: nessun selettore Tutti / Solo i miei') : bad('selettore visibile all\'utente');
!/Condivisa/.test(await u.textContent('#registro')) ? ok('utente: non vede gli eventi dell\'admin') : bad('utente vede eventi altrui');
await u.close();
await browser.close();
errs.length ? bad('errori di pagina: ' + errs.join(' · ')) : ok('nessun errore di pagina');
console.log(`\n${failures === 0 ? 'SMOKE LAYOUT OK ✓' : failures + ' VERIFICHE FALLITE ✗'}`);
process.exit(failures === 0 ? 0 : 1);
