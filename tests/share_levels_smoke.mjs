// share_levels_smoke.mjs — la pagina PUBBLICA di una cartella condivisa, per ogni
// livello del link, in un browser VERO contro il server PHP VERO.
//
// Perché serve: api_test.sh verifica le API e l'HTML con curl, share_upload_smoke.mjs
// il protocollo di share-upload.js contro uno stub. Nessuno dei due clicca davvero:
// prompt/confirm di share-actions.js, la ricarica dopo un'azione, il form del PIN con
// la sessione del browser e l'header X-CSRF, l'impaginazione a 390px.
//
// Come: copia l'app in una cartella temporanea (come api_test.sh), avvia `php -S`,
// crea l'admin e i dati via HTTP, poi apre i link in un contesto ospite di Chromium
// (nessun cookie dell'admin). I link si aprono con share.php?t=<slug>: con php -S non
// c'è la RewriteRule di /d/<slug>.
//
// Uso:  PATH=<php 8.x>:$PATH node tests/share_levels_smoke.mjs   (porta: SMOKE_PORT, default 8393)
// Richiede php e Playwright + Chromium; come editor_smoke.mjs resta fuori dalla CI.
// Esce 2 se manca playwright o php.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch (_) {
  try { ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright')); }
  catch (_) { console.error('playwright non disponibile: `npm i -D playwright`'); process.exit(2); }
}
if (spawnSync('php', ['-v']).status !== 0) { console.error('php non trovato nel PATH'); process.exit(2); }

const PORT = Number(process.env.SMOKE_PORT || 8393);
const B = `http://127.0.0.1:${PORT}`;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*-\d{8}-\d{4}-[a-hj-km-np-z2-9]{6}$/;

// ─── Sandbox: stessa disposizione della produzione (public_html accanto a storage/appdata)
const SBX = mkdtempSync(join(tmpdir(), 'desoshare-levels-'));
const PUB = join(SBX, 'public_html');
mkdirSync(PUB);
for (const f of readdirSync(APP)) {
  if (/\.(php|ico)$/.test(f) || f === '.htaccess' || f === '.user.ini') cpSync(join(APP, f), join(PUB, f));
}
cpSync(join(APP, 'assets'), join(PUB, 'assets'), { recursive: true });
const srv = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', PUB], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
let srvExited = false;
srv.on('exit', () => { srvExited = true; });
let browser = null;
async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  srv.kill();
  rmSync(SBX, { recursive: true, force: true });
}

const fails = [];
const ok = msg => console.log('  ✓ ' + msg);
const check = (cond, msg, detail) => { if (cond) ok(msg); else fails.push(msg + (detail !== undefined ? ' — ' + detail : '')); return cond; };
const eq = (got, want, msg) => check(JSON.stringify(got) === JSON.stringify(want), msg, 'atteso ' + JSON.stringify(want) + ', ricevuto ' + JSON.stringify(got));

// ─── Client HTTP dell'admin (cookie jar minimale)
const jar = new Map();
async function http(path, { method = 'GET', form = null, headers = {} } = {}) {
  const h = { ...headers };
  if (jar.size) h.Cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; method = 'POST'; }
  const r = await fetch(B + path, { method, headers: h, body, redirect: 'manual' });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  return { status: r.status, text: await r.text() };
}
let CSRF = '';
async function api(action, form = null, query = '') {
  const r = await http('/api.php?action=' + action + query, form ? { form, headers: { 'X-CSRF': CSRF } } : {});
  try { return { status: r.status, ...JSON.parse(r.text) }; } catch (_) { return { status: r.status, ok: false, raw: r.text.slice(0, 200) }; }
}
const ownList = async p => ((await api('list', null, '&path=' + encodeURIComponent(p))).items || []).map(i => i.name + (i.type === 'dir' ? '/' : '')).sort();
const ownRead = async p => (await http('/api.php?action=download&path=' + encodeURIComponent(p))).text;
async function mkshare(path, mode, extra = {}) {
  const r = await api('share_create', { path, ttl: '86400', mode, ...extra });
  if (!r.ok || !SLUG_RE.test(r.slug || '')) throw new Error('share_create ' + path + '/' + mode + ' fallita: ' + JSON.stringify(r));
  return r;
}

// ─── Browser: un contesto OSPITE per link, con guardie su errori e dialog
// Le icone vengono dal CDN di Tabler: le si sostituisce con un foglio locale che dà
// a ogni .ti il riquadro di un glifo (1em), così il test non dipende dalla rete e i
// riquadri delle icone hanno dimensioni reali per il controllo a 390px.
const ICON_CSS = '.ti{display:inline-block;width:1em;height:1em;line-height:1;vertical-align:-.125em}';
const errs = [];
async function guest(tag, { viewport, allowConsole } = {}) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: ICON_CSS }));
  const page = await ctx.newPage();
  const st = { answers: [], dialogs: [], posts: [] };
  page.on('pageerror', e => errs.push(`[${tag}] errore di pagina: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !(allowConsole && allowConsole(m))) errs.push(`[${tag}] console.error: ${m.text()}`); });
  page.on('dialog', async d => {
    st.dialogs.push({ type: d.type(), message: d.message() });
    const a = st.answers.shift();
    if (a === undefined) { errs.push(`[${tag}] dialog inatteso: ${d.type()} «${d.message()}»`); await d.dismiss(); }
    else if (a === null) await d.dismiss();
    else await d.accept(typeof a === 'string' ? a : undefined);
  });
  page.on('request', r => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api.php')) st.posts.push({ action: new URL(r.url()).searchParams.get('action'), csrf: r.headers()['x-csrf'] });
  });
  return { ctx, page, st };
}
// Esegue fn e attende la navigazione che provoca (la ricarica dopo upload/azione).
async function andReload(page, fn) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
  await fn();
  return nav;
}
const rows = page => page.$$eval('.share-row', rs => rs.map(r => ({ name: r.dataset.name, rel: r.dataset.rel, ren: !!r.querySelector('.js-ren'), del: !!r.querySelector('.js-del') })));
const names = async page => (await rows(page)).map(r => r.name).sort();
const withIcons = async (page, cls) => (await rows(page)).filter(r => r[cls]).map(r => r.name).sort();
const pageCsrf = async page => (/"csrf":"([^"]+)"/.exec(await page.content()) || [])[1] || '';
const rowSel = name => `.share-row[data-name="${name.replace(/"/g, '\\"')}"]`;
const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
// Le POST verso api.php partite da share-upload.js / share-actions.js portano tutte il token della pagina.
function postsCarryCsrf(st, csrf, tag) {
  const bad = st.posts.filter(p => p.csrf !== csrf);
  check(st.posts.length > 0 && csrf !== '' && bad.length === 0, `${tag}: header X-CSRF (token della pagina) su tutte le ${st.posts.length} POST`, JSON.stringify(bad));
}
async function scenario(name, fn) {
  console.log('=== ' + name + ' ===');
  try { await fn(); } catch (e) { fails.push(`[${name}] interrotto: ${e.message.split('\n')[0]}`); }
}

try {
  // ─── Avvio del server e dati del proprietario
  for (let i = 0; i < 50 && !srvExited; i++) {
    try { await fetch(B + '/index.php'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); }
  }
  if (srvExited) throw new Error('php -S non è partito (porta ' + PORT + ' occupata?): ' + srvLog.trim());

  console.log('=== Setup ===');
  const pre = (/name="csrf" value="([^"]+)"/.exec((await http('/index.php')).text) || [])[1] || '';
  const setup = await http('/index.php', { form: { action: 'setup', username: 'admin', password: 'secret123', csrf: pre } });
  if (setup.status !== 302) throw new Error('setup admin: atteso 302, ricevuto ' + setup.status);
  CSRF = (/data-csrf="([^"]+)"/.exec((await http('/')).text) || [])[1] || '';
  if (!CSRF) throw new Error('token CSRF della sessione admin assente');
  ok('admin creato, sessione e CSRF');
  const LONG = 'relazione-tecnica-definitiva-con-allegati-e-planimetrie-aggiornate.pdf';
  for (const d of ['lv-edit', 'lv-contrib', 'lv-manage', 'lv-manage/vecchia', 'lv-pin']) await api('mkdir', { path: dirname(d) === '.' ? '' : dirname(d), name: d.split('/').pop() });
  await api('newfile', { path: 'lv-edit', name: 'dati.txt', content: 'dati del proprietario' });
  await api('newfile', { path: 'lv-contrib', name: 'capo.txt', content: 'del capo' });
  await api('newfile', { path: 'lv-manage', name: 'proprietario.txt', content: 'del proprietario' });
  await api('newfile', { path: 'lv-manage', name: LONG, content: 'x' });
  await api('newfile', { path: 'lv-pin', name: 'segreto.txt', content: 'riservato' });
  const E = await mkshare('lv-edit', 'edit');
  const C = await mkshare('lv-contrib', 'contrib', { label: 'Avv. Bianchi' });
  const M = await mkshare('lv-manage', 'manage');
  const P = await mkshare('lv-pin', 'contrib', { pin: '1234', label: 'Cliente PIN' });
  eq([E.mode, C.mode, C.label, M.mode, P.has_pin], ['edit', 'contrib', 'Avv. Bianchi', 'manage', true], 'link creati via API (edit, contrib nominativo, manage, contrib con PIN)');
  const url = s => B + '/share.php?t=' + encodeURIComponent(s.slug);

  browser = await chromium.launch();

  // ─── Caricamento (edit): un nome esistente diventa «nome (2)», niente azioni
  await scenario('Caricamento (edit)', async () => {
    const { ctx, page, st } = await guest('edit');
    await page.goto(url(E));
    check(await page.$('#shUpInput') !== null, 'edit: pulsante «Carica file» presente');
    eq(await page.$('#shMkdir'), null, 'edit: niente «Nuova cartella»');
    eq(await page.$$eval('.js-ren, .js-del', e => e.length), 0, 'edit: nessuna icona .js-ren/.js-del');
    eq(await page.evaluate(() => typeof window.ShareActions), 'undefined', 'edit: share-actions.js non caricato');
    await page.evaluate(() => { window.__stessaPagina = true; });
    await page.setInputFiles('#shUpInput', [file('dati.txt', 'dal fornitore')]);
    await page.waitForSelector('.share-up .up-actions', { timeout: 10000 });
    eq(await page.textContent('.share-up .up-stat'), 'salvato come «dati (2).txt»', 'edit: la riga dice «salvato come «dati (2).txt»»');
    check(/Aggiorna elenco/.test(await page.textContent('.share-up .up-actions button')), 'edit: pulsante «Aggiorna elenco»');
    eq(await page.evaluate(() => window.__stessaPagina === true), true, 'edit: nessuna ricarica automatica dopo un nome cambiato');
    postsCarryCsrf(st, await pageCsrf(page), 'edit');
    await andReload(page, () => page.click('.share-up .up-actions button'));
    eq(await names(page), ['dati (2).txt', 'dati.txt'], 'edit: dopo «Aggiorna elenco» l\'elenco mostra la copia');
    eq(await page.$$eval('.js-ren, .js-del', e => e.length), 0, 'edit: ancora nessuna icona di modifica');
    eq([await ownRead('lv-edit/dati.txt'), await ownRead('lv-edit/dati (2).txt')], ['dati del proprietario', 'dal fornitore'], 'edit: il file del proprietario è intatto, la copia ha il contenuto caricato');
    await ctx.close();
  });

  // ─── Collaboratore (contrib): agisce solo sui file caricati con QUESTO link
  await scenario('Collaboratore (contrib)', async () => {
    const { ctx, page, st } = await guest('contrib');
    await page.goto(url(C));
    check(await page.$('#shMkdir') !== null, 'contrib: «Nuova cartella» presente');
    eq(await withIcons(page, 'del'), [], 'contrib: nessuna icona sul file del proprietario');
    await andReload(page, () => page.setInputFiles('#shUpInput', [file('mio.txt', 'dal collaboratore')]));
    eq(await names(page), ['capo.txt', 'mio.txt'], 'contrib: dopo il caricamento la pagina si ricarica e mostra il file');
    eq([await withIcons(page, 'ren'), await withIcons(page, 'del')], [['mio.txt'], ['mio.txt']], 'contrib: .js-ren/.js-del solo sulla riga del file caricato');
    st.answers.push('mio-rinominato.txt');
    await andReload(page, () => page.click(rowSel('mio.txt') + ' .js-ren'));
    eq(st.dialogs.at(-1)?.type, 'prompt', 'contrib: la rinomina chiede il nome con un prompt');
    eq(await names(page), ['capo.txt', 'mio-rinominato.txt'], 'contrib: file rinominato');
    eq(await withIcons(page, 'del'), ['mio-rinominato.txt'], 'contrib: il file rinominato resta del link (icone)');
    st.answers.push(true);
    await andReload(page, () => page.click(rowSel('mio-rinominato.txt') + ' .js-del'));
    const conf = st.dialogs.at(-1) || {};
    check(conf.type === 'confirm' && /30 giorni/.test(conf.message), 'contrib: conferma dell\'eliminazione con i giorni del cestino', JSON.stringify(conf));
    eq(await names(page), ['capo.txt'], 'contrib: il file sparisce dall\'elenco');
    eq(await page.$eval('#shMsg', e => e.hidden), true, 'contrib: nessun messaggio d\'errore');
    postsCarryCsrf(st, await pageCsrf(page), 'contrib');
    const tr = (await api('trash_list')).entries || [];
    const ent = tr.find(e => e.name === 'mio-rinominato.txt');
    eq(ent && [ent.orig, ent.type, ent.by], ['lv-contrib/mio-rinominato.txt', 'file', 'link «Avv. Bianchi»'], 'contrib: nel cestino del proprietario con by «link «Avv. Bianchi»»');
    eq(await ownList('lv-contrib'), ['capo.txt'], 'contrib: il proprietario vede la cartella com\'era');
    await ctx.close();
  });

  // ─── Gestione completa (manage): cartelle, eliminazione e rinomina di tutto
  await scenario('Gestione completa (manage)', async () => {
    const { ctx, page, st } = await guest('manage');
    await page.goto(url(M));
    eq(await withIcons(page, 'del'), [LONG, 'proprietario.txt', 'vecchia'].sort(), 'manage: icone su tutte le righe, cartelle comprese');
    st.answers.push('nuova');
    await andReload(page, () => page.click('#shMkdir'));
    check((await names(page)).includes('nuova'), 'manage: «Nuova cartella» via prompt');
    st.answers.push(true);
    await andReload(page, () => page.click(rowSel('vecchia') + ' .js-del'));
    check(!(await names(page)).includes('vecchia'), 'manage: cartella eliminata');
    st.answers.push('rinominato.txt');
    await andReload(page, () => page.click(rowSel('proprietario.txt') + ' .js-ren'));
    eq(await names(page), [LONG, 'nuova', 'rinominato.txt'].sort(), 'manage: file del proprietario rinominato');
    eq(await page.$eval('#shMsg', e => e.hidden), true, 'manage: nessun messaggio d\'errore');
    postsCarryCsrf(st, await pageCsrf(page), 'manage');
    eq(await ownList('lv-manage'), [LONG, 'nuova/', 'rinominato.txt'].sort(), 'manage: il proprietario vede le modifiche');
    eq(await ownRead('lv-manage/rinominato.txt'), 'del proprietario', 'manage: contenuto intatto dopo la rinomina');
    const ent = ((await api('trash_list')).entries || []).find(e => e.name === 'vecchia');
    eq(ent && [ent.orig, ent.type, ent.by], ['lv-manage/vecchia', 'dir', 'link «' + M.slug + '»'], 'manage: la cartella è nel cestino, autore = slug (link senza nome)');
    await ctx.close();
  });

  // ─── PIN: form, PIN errato, sblocco per la sessione, upload con CSRF
  await scenario('PIN', async () => {
    // Il form del PIN risponde 401/403: Chromium lo annota in console come risorsa
    // non caricata. È il contratto, non un errore della pagina.
    const { ctx, page, st } = await guest('pin', { allowConsole: m => /status of 40[13]/.test(m.text()) && m.location().url.includes('/share.php') });
    const r0 = await page.goto(url(P));
    eq(r0.status(), 401, 'pin: pagina non sbloccata → 401');
    check(await page.isVisible('input[name="pin"]'), 'pin: form del PIN mostrato');
    eq(await page.$$eval('.share-row', e => e.length), 0, 'pin: nessun contenuto prima dello sblocco');
    await page.fill('input[name="pin"]', '0000');
    const r1 = await andReload(page, () => page.click('button[type="submit"]'));
    eq(r1.status(), 403, 'pin: PIN errato → 403');
    eq((await page.textContent('.alert') || '').trim(), 'PIN non corretto', 'pin: messaggio «PIN non corretto»');
    await page.fill('input[name="pin"]', '1234');
    const r2 = await andReload(page, () => page.click('button[type="submit"]'));
    const prev = r2.request().redirectedFrom();
    eq([prev ? (await prev.response())?.status() : null, r2.status()], [303, 200], 'pin: PIN giusto → 303 e pagina 200');
    eq(await names(page), ['segreto.txt'], 'pin: elenco della cartella dopo lo sblocco');
    await andReload(page, () => page.setInputFiles('#shUpInput', [file('pin.txt', 'via pin')]));
    eq(await names(page), ['pin.txt', 'segreto.txt'], 'pin: upload riuscito (sessione sbloccata + X-CSRF)');
    eq(await withIcons(page, 'del'), ['pin.txt'], 'pin: il file caricato è del link (icone)');
    st.answers.push('cartella-pin');
    await andReload(page, () => page.click('#shMkdir'));
    check((await names(page)).includes('cartella-pin'), 'pin: «Nuova cartella» con la sessione sbloccata');
    postsCarryCsrf(st, await pageCsrf(page), 'pin');
    eq(await ownRead('lv-pin/pin.txt'), 'via pin', 'pin: il proprietario vede il file caricato');
    // Un altro ospite (altra sessione) non eredita lo sblocco.
    const other = await guest('pin-altro', { allowConsole: m => /status of 401/.test(m.text()) });
    eq((await other.page.goto(url(P))).status(), 401, 'pin: un\'altra sessione deve inserire il PIN');
    await other.ctx.close();
    await ctx.close();
  });

  // ─── Telefono (390px): le icone azione restano dentro l'elenco
  await scenario('Viewport 390px', async () => {
    for (const [tag, s] of [['edit', E], ['manage', M], ['pin', P]]) {
      const { ctx, page } = await guest('390-' + tag, { viewport: { width: 390, height: 844 }, allowConsole: m => /status of 401/.test(m.text()) });
      if (s.has_pin) {   // stesso flusso del browser: form, poi pagina sbloccata
        await page.goto(url(s));
        await page.fill('input[name="pin"]', '1234');
        await andReload(page, () => page.click('button[type="submit"]'));
      } else await page.goto(url(s));
      const r = await page.evaluate(() => {
        const L = document.querySelector('.listing').getBoundingClientRect();
        const bad = []; let n = 0;
        document.querySelectorAll('.share-row').forEach(row => {
          const nm = row.querySelector('.name').getBoundingClientRect();
          row.querySelectorAll('.share-acts .ic, .share-acts a.dl').forEach(el => {
            const b = el.getBoundingClientRect(); n++;
            const what = row.dataset.name + ' ' + el.className;
            if (b.width < 8 || b.height < 8) bad.push(what + ': riquadro nullo ' + b.width + 'x' + b.height);
            else if (b.left < L.left - 0.5 || b.right > L.right + 0.5 || b.top < L.top - 0.5 || b.bottom > L.bottom + 0.5) bad.push(what + ': fuori dall\'elenco (' + Math.round(b.left) + '–' + Math.round(b.right) + ' vs ' + Math.round(L.left) + '–' + Math.round(L.right) + ')');
            else if (b.left < nm.right - 0.5) bad.push(what + ': sovrapposta al nome');
          });
        });
        return { bad, n, sw: document.documentElement.scrollWidth };
      });
      check(r.n > 0 && r.bad.length === 0, `390px ${tag}: ${r.n} icone azione dentro l'elenco, senza sovrapporsi al nome`, r.bad.join('; '));
      check(r.sw <= 390, `390px ${tag}: nessuno scorrimento orizzontale della pagina`, 'scrollWidth ' + r.sw);
      await ctx.close();
    }
  });

  fails.push(...errs);
} catch (e) {
  fails.push('interrotto: ' + (e.message || e));
} finally {
  await cleanup();
}
if (fails.length) {
  console.error('SMOKE LIVELLI FALLITO:\n- ' + fails.join('\n- '));
  process.exit(1);
}
console.log('SMOKE LIVELLI OK ✓');
