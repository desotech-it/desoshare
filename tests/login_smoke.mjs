// login_smoke.mjs — pagina di login in un browser VERO (Chromium) contro php -S.
// Due istanze: con SSO abilitato da ambiente (OIDC_CLIENT_SECRET) → layout a due
// pannelli con «Accedi con desoauth» e credenziali locali in una sezione apribile;
// senza SSO → modulo locale sempre visibile. Verifica: niente overflow a 1920 e
// 390, logo DesoLabs, riquadro «Hai ricevuto un link», nessun numero di versione,
// errore visibile con credenziali sbagliate (sezione aperta), accesso riuscito.
// Uso: PATH=/percorso/php:$PATH node tests/login_smoke.mjs   (atteso "SMOKE LOGIN OK ✓")
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
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

async function world(port, env) {
  const SBX = mkdtempSync(join(tmpdir(), 'shlogin-'));
  const PUB = join(SBX, 'public_html');
  cpSync(APP, PUB, { recursive: true, filter: s => !/node_modules|\/tests\/|\.git(\/|$)|app-src|editor-src/.test(s) });
  const srv = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', PUB], { stdio: 'ignore', env: { ...process.env, ...env } });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { await fetch(B + '/index.php'); break; } catch { if (i > 50) throw new Error('server non avviato'); await new Promise(r => setTimeout(r, 100)); } }
  // setup dell'admin (token CSRF della pagina di setup)
  const jar = new Map();
  const req = async (path, opts = {}) => {
    const r = await fetch(B + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
    for (const sc of r.headers.getSetCookie?.() || []) { const m = /^([^=]+)=([^;]+)/.exec(sc); if (m) jar.set(m[1], m[2]); }
    return r;
  };
  const csrf = /name="csrf" value="([^"]+)"/.exec(await (await req('/index.php')).text())[1];
  await req('/index.php', { method: 'POST', body: new URLSearchParams({ action: 'setup', username: 'admin', password: 'secret123', csrf }) });
  return { B, stop: () => { try { srv.kill(); } catch {} try { rmSync(SBX, { recursive: true, force: true }); } catch {} } };
}
const overflow = p => p.evaluate(() => document.documentElement.scrollWidth > innerWidth);

const browser = await chromium.launch();
const errs = [];

console.log('\nCaso: SSO abilitato + account locale');
const w1 = await world(8411, { OIDC_CLIENT_SECRET: 'segreto-di-prova' });
{
  const p = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(w1.B + '/index.php');
  (await p.$('.lg-brand')) && (await p.$eval('.lg-brand', e => e.getBoundingClientRect().width)) > 600 ? ok('pannello di marca a sinistra a 1920') : bad('pannello di marca assente o stretto');
  (await p.$eval('.lg-logo-box img', i => i.naturalWidth)) > 0 ? ok('logo DesoLabs caricato') : bad('logo non caricato');
  (await p.$eval('a.btn-sso', a => a.getAttribute('href'))) === 'index.php?action=oidc_login' ? ok('«Accedi con desoauth» → oidc_login') : bad('link SSO errato');
  (await p.$eval('details.lg-local', d => !d.open)) ? ok('credenziali locali in sezione chiusa di default') : bad('sezione locale aperta di default');
  (await p.$('#login-method')) === null ? ok('niente menu a tendina del metodo') : bad('menu a tendina ancora presente');
  (await p.$('.lg-linkbox')) ? ok('riquadro «Hai ricevuto un link»') : bad('riquadro link assente');
  !/v0\.\d+\.\d+/.test(await p.textContent('body')) ? ok('nessun numero di versione in pagina') : bad('versione ancora in pagina');
  !(await overflow(p)) ? ok('1920: nessuno scorrimento orizzontale') : bad('1920: overflow orizzontale');
  // credenziali sbagliate → errore e sezione aperta
  await p.click('details.lg-local summary');
  await p.fill('#lg-user', 'admin'); await p.fill('#lg-pass', 'sbagliata'); await p.click('.lg-local button[type=submit]');
  await p.waitForSelector('.alert');
  /Credenziali non valide/.test(await p.textContent('.alert')) ? ok('errore «Credenziali non valide» visibile') : bad('errore non mostrato');
  (await p.$eval('details.lg-local', d => d.open)) ? ok('con errore la sezione locale resta aperta') : bad('sezione chiusa dopo l\'errore');
  // credenziali giuste → app
  await p.fill('#lg-user', 'admin'); await p.fill('#lg-pass', 'secret123'); await p.click('.lg-local button[type=submit]');
  await p.waitForSelector('#app', { timeout: 10000 }).then(() => ok('accesso riuscito: app caricata'), () => bad('accesso non riuscito'));
  await p.close();
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  m.on('pageerror', e => errs.push(e.message));
  await m.goto(w1.B + '/index.php');
  !(await overflow(m)) ? ok('390: nessuno scorrimento orizzontale') : bad('390: overflow orizzontale');
  (await m.$eval('.lg-brand', e => e.getBoundingClientRect().height)) < 140 ? ok('390: marca ridotta a fascia compatta') : bad('390: pannello di marca troppo alto');
  await m.click('details.lg-local summary');
  (await m.$eval('#lg-user', e => e.getBoundingClientRect().height)) >= 40 ? ok('390: campi alti almeno 40px') : bad('390: campi troppo bassi');
  await m.close();
}
w1.stop();

console.log('\nCaso: solo account locale (SSO non configurato)');
const w2 = await world(8412, { OIDC_CLIENT_SECRET: '' });
{
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(w2.B + '/index.php');
  (await p.$('a.btn-sso')) === null ? ok('nessun bottone SSO') : bad('bottone SSO presente senza SSO');
  (await p.$('details.lg-local')) === null && (await p.$('#lg-user')) ? ok('modulo locale sempre visibile') : bad('modulo locale non visibile direttamente');
  (await p.$eval('#lg-user', e => document.activeElement === e)) ? ok('campo username con il fuoco') : bad('autofocus assente');
  await p.fill('#lg-user', 'admin'); await p.fill('#lg-pass', 'nope'); await p.click('.lg-local button[type=submit]');
  await p.waitForSelector('.alert');
  ok('errore mostrato anche nel caso solo locale');
  await p.close();
}
w2.stop();
await browser.close();
errs.length ? bad('errori di pagina: ' + errs.join(' · ')) : ok('nessun errore di pagina');
console.log(`\n${failures === 0 ? 'SMOKE LOGIN OK ✓' : failures + ' VERIFICHE FALLITE ✗'}`);
process.exit(failures === 0 ? 0 : 1);
