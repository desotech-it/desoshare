// preview_smoke.mjs — anteprima dei documenti in un browser VERO (Chromium) contro
// un'istanza reale (php -S): PDF, MD, TXT, DOCX, RTF, XLSX (più fogli), XLS, CSV,
// e .doc (solo messaggio). Verifica il contenuto mostrato, sia nell'app (sessione)
// sia nella pagina pubblica di un link in sola lettura, e che il Markdown con
// <script> e onerror NON esegua codice (iframe sandbox + DOMPurify).
// Uso: PATH=/percorso/php:$PATH node tests/preview_smoke.mjs   (atteso "SMOKE ANTEPRIMA OK ✓")
// Fuori dalla CI (serve il browser); esce 2 se playwright manca.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {
  try { ({ chromium } = createRequire('/usr/lib/node_modules/')('playwright')); } catch (_) { console.error('playwright non disponibile'); process.exit(2); }
}
const JSZip = require(join(APP, 'assets/vendor/jszip.min.js'));
const XLSX = require(join(APP, 'assets/vendor/preview/xlsx.full.min.js'));

const PORT = Number(process.env.PORT || 8394);
const B = `http://127.0.0.1:${PORT}`;
let failures = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failures++; console.log('  ✗ ' + m); };

// ─── File di prova ───────────────────────────────────────────────────────────
function pdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 30 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
async function docx(text) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
function sheet(type) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Voce', 'Importo'], ['Cella XLS ' + type, 42]]), 'Primo');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Secondo foglio ' + type]]), 'Secondo');
  return XLSX.write(wb, { type: 'buffer', bookType: type });
}
const files = {
  'doc.pdf': pdf('Ciao PDF'),
  'nota.md': Buffer.from('# Titolo MD\n\nTesto **forte**.\n\n<script>parent.__xss=1</script><img src=x onerror="parent.__xss=1">\n'),
  'testo.txt': Buffer.from('Riga di testo semplice\n'),
  'lettera.docx': await docx('Ciao DOCX'),
  'lettera.rtf': Buffer.from('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Ciao RTF\\par}'),
  'conti.xlsx': sheet('xlsx'),
  'vecchio.xls': sheet('xls'),
  'dati.csv': Buffer.from('Nome;Valore\nCella CSV;7\n'),
  'antico.doc': Buffer.from('\xd0\xcf\x11\xe0 finto doc', 'latin1'),
};
const EXPECT = {
  'doc.pdf': { canvas: true }, 'nota.md': { text: 'Titolo MD', frame: true }, 'lettera.docx': { text: 'Ciao DOCX', frame: true },
  'lettera.rtf': { text: 'Ciao RTF', frame: true }, 'conti.xlsx': { text: 'Cella XLS xlsx', frame: true, tab: 'Secondo', tabText: 'Secondo foglio xlsx' },
  'vecchio.xls': { text: 'Cella XLS xls', frame: true }, 'dati.csv': { text: 'Cella CSV', frame: true }, 'antico.doc': { msg: 'non è disponibile' },
};

// ─── Sandbox reale ───────────────────────────────────────────────────────────
const SBX = mkdtempSync(join(tmpdir(), 'shprev-'));
const PUB = join(SBX, 'public_html');
cpSync(APP, PUB, { recursive: true, filter: s => !/node_modules|\/tests\/|\.git(\/|$)|app-src|editor-src/.test(s) });
const srv = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', PUB], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill(); } catch {} try { rmSync(SBX, { recursive: true, force: true }); } catch {} });
for (let i = 0; ; i++) { try { await fetch(B + '/index.php'); break; } catch { if (i > 50) throw new Error('server non avviato'); await new Promise(r => setTimeout(r, 100)); } }

const jar = new Map();
async function req(path, opts = {}) {
  const r = await fetch(B + path, { redirect: 'manual', ...opts, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers || {}) } });
  for (const sc of r.headers.getSetCookie?.() || []) { const m = /^([^=]+)=([^;]+)/.exec(sc); if (m) jar.set(m[1], m[2]); }
  return r;
}
const pre = async () => /name="csrf" value="([^"]+)"/.exec(await (await req('/index.php')).text())[1];
await req('/index.php', { method: 'POST', body: new URLSearchParams({ action: 'setup', username: 'admin', password: 'secret123', csrf: await pre() }) });
const CSRF = /data-csrf="([^"]+)"/.exec(await (await req('/')).text())[1];
const api = async (action, data) => { const b = new FormData(); for (const [k, v] of Object.entries(data)) b.append(k, v); return (await req('/api.php?action=' + action, { method: 'POST', body: b, headers: { 'X-CSRF': CSRF } })).json(); };
await api('mkdir', { path: '', name: 'docs' });
const fd = new FormData(); fd.append('path', 'docs');
for (const [n, buf] of Object.entries(files)) fd.append('files[]', new Blob([buf]), n);
const up = await (await req('/api.php?action=upload', { method: 'POST', body: fd, headers: { 'X-CSRF': CSRF } })).json();
up.saved === Object.keys(files).length ? ok(`${up.saved} file di prova caricati`) : bad('upload: ' + JSON.stringify(up));
const share = await api('share_create', { path: 'docs', ttl: '3600', mode: 'view' });

// ─── Browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
async function check(page, where, open) {
  for (const [name, exp] of Object.entries(EXPECT)) {
    await open(name);
    await page.waitForSelector('.pv-overlay');
    try {
      if (exp.canvas) {
        await page.waitForSelector('.pv-pages canvas', { timeout: 15000 });
        const inked = await page.evaluate(() => { const c = document.querySelector('.pv-pages canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return true; return false; });
        inked ? ok(`${where}: ${name} disegnato (pagina con testo)`) : bad(`${where}: ${name} pagina vuota`);
      } else if (exp.msg) {
        await page.waitForFunction(t => (document.querySelector('.pv-msg')?.textContent || '').includes(t), exp.msg, { timeout: 5000 });
        ok(`${where}: ${name} → messaggio «anteprima non disponibile» e pulsante Scarica`);
      } else {
        const fr = await (await page.waitForSelector('.pv-frame', { timeout: 15000 })).contentFrame();
        await fr.waitForFunction(t => document.body.innerText.includes(t), exp.text, { timeout: 15000 });
        ok(`${where}: ${name} mostra «${exp.text}»`);
        const sb = await page.$eval('.pv-frame', f => f.getAttribute('sandbox'));
        sb === 'allow-same-origin' ? ok(`${where}: ${name} in iframe sandbox senza script`) : bad(`${where}: sandbox «${sb}»`);
        if (exp.tab) {
          await page.click(`.pv-tabs button:text("${exp.tab}")`);
          await fr.waitForFunction(t => document.body.innerText.includes(t), exp.tabText, { timeout: 5000 });
          ok(`${where}: ${name} cambio foglio → «${exp.tabText}»`);
        }
      }
    } catch (e) { bad(`${where}: ${name} — ${e.message.split('\n')[0]}`); }
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${where}-${name}.png`) });
    const dl = await page.$eval('.pv-dl', a => a.getAttribute('href'));
    dl ? null : bad(`${where}: ${name} senza link di download`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pv-overlay', { state: 'detached' });
  }
  (await page.evaluate(() => window.__xss)) === undefined ? ok(`${where}: Markdown con <script>/onerror non ha eseguito codice`) : bad(`${where}: XSS eseguito dal Markdown`);
}

const errs = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, url: B })));
const app = await ctx.newPage();
app.on('pageerror', e => errs.push('app: ' + e.message));
await app.goto(B + '/');
await app.click('#rows .row .label:text("docs")');
await app.waitForSelector('#rows .row .label:text("doc.pdf")');
console.log('\nApp (sessione)');
await check(app, 'app', n => app.click(`#rows .row .label:text("${n}")`));
await app.click('#rows .row .label:text("nota.md")');
(await app.$('.pv-edit')) ? ok('app: nota.md ha «Modifica» (apre l\'editor)') : bad('app: manca «Modifica» per la nota');
await app.keyboard.press('Escape');
await app.click('#rows .row .label:text("testo.txt")');
await app.waitForSelector('#modalBg:not([hidden])', { timeout: 5000 }).then(() => ok('app: testo.txt apre ancora l\'editor'), () => bad('app: testo.txt non apre l\'editor'));

console.log('\nPagina pubblica (link in sola lettura)');
const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
guest.on('pageerror', e => errs.push('pubblica: ' + e.message));
await guest.goto(`${B}/share.php?t=${share.slug}`);
await check(guest, 'pubblica', n => guest.click(`.share-row[data-name="${n}"] .js-pv`));
console.log('\nRegistro degli accessi (proprietario)');
await app.goto(B + '/');
await app.click('#btnShares');
await app.click('[data-acc]');
await app.waitForSelector('.acc-sum');
const sum = await app.textContent('.acc-sum');
/\b[1-9]\d*\s*visite/.test(sum) ? ok('pannello del link: visite contate (' + sum.replace(/\s+/g, ' ').trim() + ')') : bad('riepilogo senza visite: ' + sum);
const accRows = await app.$$eval('.acc-table tbody tr', trs => trs.map(t => t.textContent));
accRows.some(t => t.includes('Anteprima') && t.includes('127.0.0.1')) ? ok('pannello del link: anteprime dell\'ospite con IP') : bad('anteprime non presenti nel pannello');
await app.click('#acc_back');
await app.waitForSelector('[data-acc]');
await app.keyboard.press('Escape');
await app.click('#btnAdmin');
await app.click('text=Registro');
await app.waitForSelector('#reg_body .acc-table');
(await app.$$('#reg_body .acc-table tbody tr')).length > 5 ? ok('amministrazione: scheda Accessi popolata') : bad('scheda Accessi vuota');
await app.fill('#af_ip', '127.0.0.1'); await app.selectOption('#af_event', 'share_view'); await app.click('#af_go');
await app.waitForTimeout(400);
const evs = await app.$$eval('#reg_body .acc-table tbody tr td:nth-child(2)', tds => tds.map(t => t.textContent));
evs.length && evs.every(t => t.startsWith('Visita del link')) ? ok(`amministrazione: filtro evento+IP (${evs.length} visite)`) : bad('filtro non applicato: ' + evs.slice(0, 3).join(' | '));
errs.length ? bad('errori di pagina: ' + errs.join(' · ')) : ok('nessun errore di pagina');
await browser.close();
console.log(`\n${failures === 0 ? 'SMOKE ANTEPRIMA OK ✓' : failures + ' VERIFICHE FALLITE ✗'}`);
process.exit(failures === 0 ? 0 : 1);
