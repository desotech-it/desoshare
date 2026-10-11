// Test MODEL-BASED dei cicli di vita: esegue sequenze pseudo-casuali (seed
// riproducibile) di operazioni reali contro un'istanza isolata (php -S),
// mantenendo un MODELLO dello stato atteso e verificando le invarianti dopo
// ogni passo. Trova i bug emergenti dalle SEQUENZE (es. contenuto che "risorge"
// dopo cancella+ricrea) che i test per-operazione non vedono.
//
// Oltre alle operazioni del proprietario copre i link di cartella a livelli
// (edit/contrib/manage), la provenienza dei file caricati via link e il cestino.
// Invarianti verificate dopo OGNI passo:
//  (1) lo storage (letto dal disco della sandbox) coincide col modello;
//  (2) un link «collaboratore» può eliminare/rinominare un file se e solo se il
//      modello dice che l'ha caricato lui e da allora nessuno l'ha cambiato o spostato;
//  (3) i link edit/contrib non cambiano mai il contenuto di file che non sono loro;
//  (4) ogni eliminazione/sovrascrittura via link produce una voce di cestino con il
//      contenuto identico, e il ripristino lo riporta;
//  (5) il consumo del proprietario (in cache e ricalcolato) = home + cestino;
//  (6) nessuna share punta a un elemento eliminato o revocato.
// Ogni 10 passi anche i controlli HTTP più costosi: elenco, note, download, pagine
// pubbliche dei link con le azioni concesse riga per riga.
//
// Uso:  node tests/lifecycle_fuzz.mjs [seed] [nOps]
//       SEEDS="1 2 3" OPS=150 node tests/lifecycle_fuzz.mjs   (più run)
//       PORT=8397 (default) · DEBUG=1 mostra gli errori di php -S · KEEP=1 conserva la sandbox se fallisce
//       UNIQUE_SIZES=1: ogni versione di file ha una dimensione diversa (isola i problemi
//       di provenienza dimensione+data da tutto il resto)
// Ogni seed gira in una sandbox NUOVA: una violazione si riproduce col solo seed.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8397);
const B = `http://127.0.0.1:${PORT}`;
const USER = 'admin';

// ─── PRNG con seed (mulberry32): stessa sequenza a ogni run con lo stesso seed ─
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Client HTTP ─────────────────────────────────────────────────────────────
// Sessione del proprietario (cookie jar + CSRF) e richieste ANONIME dei link
// (niente cookie: il token o l'indirizzo è la credenziale).
const jar = new Map();
let CSRF = '';
function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(path, opts = {}) {
  const r = await fetch(B + path, { redirect: 'manual', ...opts, headers: { cookie: cookieHeader(), ...(opts.headers || {}) } });
  for (const sc of r.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]+)/.exec(sc);
    if (m) jar.set(m[1], m[2]);
  }
  return r;
}
async function asJson(r) {
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const errOf = r => r.j ? `HTTP ${r.status} ${r.j.error || JSON.stringify(r.j).slice(0, 200)}` : `HTTP ${r.status} risposta non JSON: ${r.text.slice(0, 300)}`;
function form(data) {
  const body = new FormData();
  for (const [k, v] of Object.entries(data)) body.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
  return body;
}
const sget = async (action, data = {}) => asJson(await req('/api.php?' + new URLSearchParams({ action, ...data })));
const spost = async (action, data = {}, body = null) =>
  asJson(await req('/api.php?action=' + action, { method: 'POST', body: body || form(data), headers: { 'X-CSRF': CSRF } }));
const lpost = async (action, t, data = {}, body = null) =>
  asJson(await fetch(`${B}/api.php?action=${action}&t=${encodeURIComponent(t)}`, { method: 'POST', body: body || form(data), redirect: 'manual' }));
async function lpage(t, p = '') {
  const r = await fetch(`${B}/share.php?` + new URLSearchParams(p ? { t, p } : { t }), { redirect: 'manual' });
  return { status: r.status, html: await r.text() };
}

// ─── Sandbox: una per seed ───────────────────────────────────────────────────
let SBX = '', srv = null;
const phpLog = [];
async function startWorld() {
  SBX = mkdtempSync(join(tmpdir(), 'shfuzz-'));
  const PUB = join(SBX, 'public_html');
  cpSync(APP, PUB, { recursive: true, filter: (src) => !/node_modules|\/tests\/|\.git(\/|$)/.test(src) });
  phpLog.length = 0;
  // Il fuzzer interroga di proposito link morti (revocati/eliminati): senza alzare
  // la soglia anti-enumerazione l'IP verrebbe bloccato (429) dopo pochi controlli.
  srv = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', PUB], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SHARE_LOOKUP_MAX_FAILS: '1000000' },
  });
  srv.stderr.on('data', (d) => {
    for (const l of String(d).split('\n')) {
      if (!l.trim() || /\] 127\.0\.0\.1:\d+ (Accepted|Closing|\[\d+\]:)|Development Server .* started/.test(l)) continue;
      if (process.env.DEBUG) console.error('php: ' + l);
      phpLog.push(l); if (phpLog.length > 40) phpLog.shift();
    }
  });
  // Attesa ATTIVA del server: in CI l'avvio di php -S può superare uno sleep fisso.
  for (let i = 0; ; i++) {
    if (srv.exitCode !== null) throw new Error(`php -S terminato subito (porta ${PORT} occupata?)`);
    try { await fetch(B + '/index.php'); break; }
    catch (e) { if (i >= 100) throw new Error('php -S non risponde: ' + e.message); await new Promise(r => setTimeout(r, 200)); }
  }
  jar.clear(); CSRF = '';
  await bootstrap();
}
async function stopWorld(keep = false) {
  if (srv && srv.exitCode === null && srv.signalCode === null) {
    const gone = new Promise(r => srv.once('exit', r));
    srv.kill(); await gone;
  }
  srv = null;
  if (keep) console.log(`  sandbox conservata: ${SBX}`);
  else if (SBX) { try { rmSync(SBX, { recursive: true, force: true }); } catch {} }
  SBX = '';
}
process.on('exit', () => { try { srv?.kill(); } catch {} try { if (SBX && !process.env.KEEP) rmSync(SBX, { recursive: true, force: true }); } catch {} });

async function bootstrap() {
  const page = await (await req('/index.php')).text();
  const pre = /name="csrf" value="([^"]+)"/.exec(page)?.[1] || '';
  if (!pre) throw new Error('bootstrap: form di setup senza csrf. Pagina: ' + page.slice(0, 500));
  const fd = new URLSearchParams({ action: 'setup', username: USER, password: 'secret123', csrf: pre });
  const sr = await req('/index.php', { method: 'POST', body: fd });
  const app = await (await req('/')).text();
  CSRF = /data-csrf="([^"]+)"/.exec(app)?.[1] || '';
  if (!CSRF) throw new Error(`bootstrap fallito: niente CSRF post-login (setup HTTP ${sr.status}). Pagina: ` + app.slice(0, 500));
}

// ─── Modello dello stato atteso ──────────────────────────────────────────────
// files: Map<relPath, blob> · dirs: Set<relPath> (percorsi relativi alla home)
// blob = {id, content}: una VERSIONE di un file. Rinomine e cestino spostano lo
//   stesso blob; ogni scrittura (upload, nota, sovrascrittura) ne crea uno nuovo.
// shares: Map<token, {token, slug, path, alive, mode, label, isDir, records}>
//   records: Map<rel dal link, blob.id> = i file caricati con QUEL link. Il link
//   «possiede» il file in rel solo se lì c'è ancora la stessa versione.
// trash: [{id, orig, name, type, files: Map<sub, blob>, dirs: Set<sub>, by}]
//   (id null finché trash_list non lo rivela; sub '' = la voce stessa se file).
let M;
let blobSeq = 0;
function resetModel() { M = { files: new Map(), dirs: new Set(), shares: new Map(), trash: [] }; }
const newBlob = content => ({ id: ++blobSeq, content });
const parentOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const baseName = p => p.slice(p.lastIndexOf('/') + 1);
const join2 = (a, b) => a === '' ? b : (b === '' ? a : `${a}/${b}`);
const under = (p, base) => base === '' || p === base || p.startsWith(base + '/');
const ensureDirs = dir => { for (let a = dir; a; a = parentOf(a)) M.dirs.add(a); };
const ancestors = p => { const out = []; for (let a = parentOf(p); a; a = parentOf(a)) out.push(a); return out; };
const exists = p => M.files.has(p) || M.dirs.has(p);
const modelChildren = dir => {
  const pfx = dir ? dir + '/' : '';
  const names = new Set();
  for (const p of [...M.files.keys(), ...M.dirs]) {
    if (p !== dir && p.startsWith(pfx)) names.add(p.slice(pfx.length).split('/')[0]);
  }
  return names;
};
const revokeUnder = p => { for (const s of M.shares.values()) if (s.alive && s.path !== '' && (s.path === p || s.path.startsWith(p + '/'))) s.alive = false; };
// Eliminazione del PROPRIETARIO (sessione): definitiva, niente cestino.
const deleteSubtree = (p) => {
  for (const k of [...M.files.keys()]) if (k === p || k.startsWith(p + '/')) M.files.delete(k);
  for (const k of [...M.dirs]) if (k === p || k.startsWith(p + '/')) M.dirs.delete(k);
  revokeUnder(p);
};
const renameSubtree = (from, to) => {
  const mv = (k) => k === from ? to : (k.startsWith(from + '/') ? to + k.slice(from.length) : k);
  const nf = new Map(); for (const [k, v] of M.files) nf.set(mv(k), v); M.files = nf;
  M.dirs = new Set([...M.dirs].map(mv));
  for (const s of M.shares.values()) if (s.path !== '') s.path = mv(s.path);
};
// Sposta p (file o cartella) nel cestino del modello.
const toTrash = (p, by) => {
  const e = { id: null, orig: p, name: baseName(p), type: M.dirs.has(p) ? 'dir' : 'file', files: new Map(), dirs: new Set(), by };
  if (e.type === 'file') { e.files.set('', M.files.get(p)); M.files.delete(p); }
  else {
    for (const k of [...M.files.keys()]) if (k.startsWith(p + '/')) { e.files.set(k.slice(p.length + 1), M.files.get(k)); M.files.delete(k); }
    for (const k of [...M.dirs]) if (k.startsWith(p + '/')) { e.dirs.add(k.slice(p.length + 1)); M.dirs.delete(k); }
    M.dirs.delete(p);
  }
  M.trash.push(e);
  return e;
};
// Fotografia del modello, per le operazioni il cui esito atteso si conosce solo dalla risposta.
const snapModel = () => ({ files: new Map(M.files), dirs: new Set(M.dirs), trash: [...M.trash],
  shares: [...M.shares.values()].map(s => [s, s.path, s.alive, new Map(s.records)]) });
function restoreModel(sn) {
  M.files = sn.files; M.dirs = sn.dirs; M.trash = sn.trash;
  for (const [s, p, a, r] of sn.shares) { s.path = p; s.alive = a; s.records = r; }
}
const trashSize = e => [...e.files.values()].reduce((n, b) => n + Buffer.byteLength(b.content), 0);

// Link: percorsi relativi, provenienza, permessi attesi.
const relOf = (s, p) => s.path === '' ? p : (p === s.path ? '' : p.slice(s.path.length + 1));
const absOf = (s, rel) => rel === '' ? s.path : join2(s.path, rel);
const isOwn = (s, p) => { const b = M.files.get(p); return !!b && s.records.get(relOf(s, p)) === b.id; };
const mayTouch = (s, p) => s.mode === 'manage' || (s.mode === 'contrib' && isOwn(s, p));
const actor = s => `link «${s.label || s.slug}»`;
// «nome (n).ext»; senza estensione (o nome che inizia col punto) il suffisso va in coda.
function variantName(name, n) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
// Destinazione di un upload via link: nome libero → quello; file che il link può
// sostituire ('manage' sempre, 'contrib' se è suo) → sostituzione; altrimenti il
// primo «nome (n)» utilizzabile. Le cartelle omonime si saltano.
function uploadTarget(s, dir, name) {
  for (let n = 1; n <= 500; n++) {
    const cand = join2(dir, n === 1 ? name : variantName(name, n));
    if (M.dirs.has(cand)) continue;
    if (M.files.has(cand)) {
      if (!mayTouch(s, cand)) continue;
      return { path: cand, replace: true };
    }
    return { path: cand, replace: false };
  }
  throw new Error('uploadTarget: troppe varianti');
}
// Ripristino dal cestino: origine, o «nome (n)» se occupata. Se un antenato è
// diventato un FILE la cartella non si può ricreare: atteso errore, voce intatta.
function restoreTarget(e) {
  let t = e.orig;
  for (let n = 2; exists(t); n++) t = join2(parentOf(e.orig), variantName(e.name, n));
  return { path: t, blocked: ancestors(t).some(a => M.files.has(a)) };
}

// ─── Lettura diretta della sandbox ───────────────────────────────────────────
const STORE = () => join(SBX, 'storage');
function walk(root) {
  const files = new Map(), dirs = new Set();
  const rec = (abs, rel) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { dirs.add(r); rec(join(abs, d.name), r); }
      else files.set(r, readFileSync(join(abs, d.name), 'utf8'));
    }
  };
  if (existsSync(root)) rec(root, '');
  return { files, dirs };
}
const readJson = f => { try { return JSON.parse(readFileSync(join(SBX, 'appdata', f), 'utf8')); } catch { return {}; } };
const auditSize = () => { try { return statSync(join(SBX, 'appdata', 'audit.log')).size; } catch { return 0; } };
const auditSince = n => { try { return readFileSync(join(SBX, 'appdata', 'audit.log')).subarray(n).toString('utf8'); } catch { return ''; } };

// ─── Invarianti ──────────────────────────────────────────────────────────────
const fails = [];
let CUR = { seed: 0, step: 0 };
let seedFailed = false;
function violation(msg) {
  const m = `[seed ${CUR.seed}, passo ${CUR.step}] ${msg}`;
  fails.push(m); seedFailed = true;
  console.log('  ✗ INVARIANTE VIOLATA: ' + m);
}
const desc8 = t => t.slice(0, 8);
// Copertura: quante volte si è arrivati a ciascun caso interessante (stampata alla
// fine), per accorgersi se il fuzzer smette di esercitare qualcosa.
const cov = new Map();
const hit = k => cov.set(k, (cov.get(k) || 0) + 1);

// (3) Guardia per i link edit/contrib: i file che il link NON possiede devono
// restare identici e al loro posto, qualunque cosa faccia il link.
function foreignGuard(s, what) {
  if (s.mode !== 'edit' && s.mode !== 'contrib') return () => {};
  const before = walk(join(STORE(), USER)).files;
  const allowed = new Set([...M.files.keys()].filter(p => isOwn(s, p)));
  return () => {
    const after = walk(join(STORE(), USER)).files;
    for (const [p, c] of before) {
      if (allowed.has(p)) continue;
      if (!after.has(p)) violation(`(3) ${what} via link ${s.mode} ${desc8(s.token)}: il file altrui ${p} è sparito`);
      else if (after.get(p) !== c) violation(`(3) ${what} via link ${s.mode} ${desc8(s.token)}: contenuto del file altrui ${p} cambiato`);
    }
  };
}
// Ogni operazione riuscita via link lascia nel registro l'autore «link «nome»».
function auditExpect(mark, action, s) {
  const add = auditSince(mark);
  if (!add.split('\n').some(l => l.split('\t')[1] === actor(s) && l.split('\t')[2] === action))
    violation(`registro: manca "${action}" con autore ${actor(s)} (aggiunto: ${JSON.stringify(add.slice(0, 200))})`);
}

// Il contenuto custodito su disco per la voce `id` è quello della voce di modello e?
function trashOnDiskIs(e, id) {
  const at = join(STORE(), '~cestino', USER, id, e.name);
  if (!existsSync(at)) return false;
  if (e.type === 'file') return readFileSync(at, 'utf8') === e.files.get('').content;
  const w = walk(at);
  return w.files.size === e.files.size && [...e.files].every(([k, b]) => w.files.get(k) === b.content)
    && w.dirs.size === e.dirs.size && [...e.dirs].every(d => w.dirs.has(d));
}

// Dopo OGNI passo: cestino, storage, consumo, share.
async function checkStep() {
  // (4) Voci del cestino: l'elenco del server = quelle attese (gli id nuovi si abbinano per origine).
  const tl = await sget('trash_list');
  if (!tl.j?.ok) { violation(`trash_list fallita: ${errOf(tl)}`); return; }
  const known = new Map(M.trash.filter(e => e.id).map(e => [e.id, e]));
  const pending = M.trash.filter(e => !e.id);
  for (const g of tl.j.entries) {
    let e = known.get(g.id);
    if (e) known.delete(g.id);
    else {
      // Più voci con la stessa origine nello stesso passo (es. due sostituzioni di fila):
      // si sceglie quella il cui contenuto coincide con ciò che il server ha custodito.
      const cands = pending.filter(x => x.orig === g.orig && x.name === g.name && x.type === g.type);
      const i = pending.indexOf(cands.length > 1 ? (cands.find(x => trashOnDiskIs(x, g.id)) || cands[0]) : cands[0]);
      if (i < 0) { violation(`(4) voce di cestino inattesa: ${g.type} ${g.orig} (di ${g.by})`); continue; }
      e = pending.splice(i, 1)[0]; e.id = g.id;
    }
    if (g.size !== trashSize(e)) violation(`(4) cestino ${g.orig}: size ${g.size} ≠ attesa ${trashSize(e)}`);
    if (g.by !== e.by) violation(`(4) cestino ${g.orig}: autore "${g.by}" ≠ atteso "${e.by}"`);
  }
  for (const e of known.values()) violation(`(4) voce di cestino sparita: ${e.type} ${e.orig}`);
  for (const e of pending) violation(`(4) manca la voce di cestino per ${e.type} ${e.orig} (eliminato/sostituito via link)`);

  // (1) Lo storage della home coincide col modello (contenuto compreso).
  const st = walk(join(STORE(), USER));
  for (const [p, b] of M.files) {
    if (!st.files.has(p)) violation(`(1) storage: manca il file ${p}`);
    else if (st.files.get(p) !== b.content) violation(`(1) storage: ${p} contiene ${JSON.stringify(st.files.get(p).slice(0, 40))} ≠ atteso ${JSON.stringify(b.content.slice(0, 40))}`);
  }
  for (const p of st.files.keys()) if (!M.files.has(p)) violation(`(1) storage: file inatteso ${p}`);
  for (const d of M.dirs) if (!st.dirs.has(d)) violation(`(1) storage: manca la cartella ${d}`);
  for (const d of st.dirs) if (!M.dirs.has(d)) violation(`(1) storage: cartella inattesa ${d}`);

  // (4) Il contenuto custodito nel cestino è identico a quello eliminato/sostituito.
  const troot = join(STORE(), '~cestino', USER);
  const ids = existsSync(troot) ? readdirSync(troot) : [];
  const byId = new Map(M.trash.filter(e => e.id).map(e => [e.id, e]));
  for (const id of ids) if (!byId.has(id)) violation(`(4) cestino su disco: residuo inatteso ${id}/${readdirSync(join(troot, id)).join(',')}`);
  for (const e of byId.values()) {
    if (!existsSync(join(troot, e.id, e.name))) violation(`(4) cestino su disco: manca ${e.id}/${e.name} (${e.orig})`);
    else if (!trashOnDiskIs(e, e.id)) violation(`(4) cestino su disco: ${e.type} ${e.orig} con contenuto diverso da quello eliminato/sostituito`);
  }
  // Nessuna prenotazione di nome rimasta appesa (bloccherebbe quel nome per ore).
  const pend = Object.keys(readJson('link_files.json').pending || {});
  if (pend.length) violation(`prenotazioni di upload non rilasciate: ${pend.join(', ')}`);

  // (5) Consumo = home + cestino: sia il valore in cache (aggiornato a delta) sia il ricalcolo.
  const want = [...M.files.values()].reduce((n, b) => n + Buffer.byteLength(b.content), 0) + M.trash.reduce((n, e) => n + trashSize(e), 0);
  const cached = (await sget('usage_list')).j?.users?.find(u => u.username === USER)?.usage;
  const fresh = (await sget('usage_list', { refresh: USER })).j?.users?.find(u => u.username === USER)?.usage;
  if (fresh !== want) violation(`(5) consumo ricalcolato ${fresh} ≠ home+cestino ${want}`);
  if (cached !== want) violation(`(5) consumo in cache ${cached} ≠ home+cestino ${want} (deriva dei delta)`);

  // (6) Le share attive sono esattamente quelle vive nel modello, sui percorsi giusti.
  const sl = await sget('share_list');
  if (!sl.j?.ok) { violation(`share_list fallita: ${errOf(sl)}`); return; }
  const listed = new Map(sl.j.shares.map(x => [x.token, x]));
  for (const s of M.shares.values()) {
    const x = listed.get(s.token);
    if (!s.alive) { if (x) violation(`(6) share ${desc8(s.token)} (${s.path}) elencata ma dovrebbe essere morta`); continue; }
    if (!x) { violation(`(6) share ${desc8(s.token)} (${s.path}) sparita dall'elenco`); continue; }
    if (x.path !== s.path) violation(`(6) share ${desc8(s.token)}: path "${x.path}" ≠ atteso "${s.path}"`);
    if (x.mode !== s.mode || x.level !== s.mode) violation(`(6) share ${desc8(s.token)}: livello ${x.mode}/${x.level} ≠ ${s.mode}`);
    if (x.label !== s.label) violation(`(6) share ${desc8(s.token)}: label "${x.label}" ≠ "${s.label}"`);
  }
  for (const x of sl.j.shares) {
    if (!M.shares.get(x.token)?.alive) violation(`(6) share inattesa ${desc8(x.token)} su "${x.path}"`);
    if (x.path !== '' && !exists(x.path)) violation(`(6) share ${desc8(x.token)} punta a "${x.path}", che non esiste`);
  }
}

// Ogni 10 passi: le viste HTTP coincidono col modello.
async function checkDeep() {
  // Elenco di ogni cartella.
  for (const dir of ['', ...M.dirs]) {
    const r = await sget('list', { path: dir });
    if (!r.j?.ok) { violation(`list(${dir || '/'}) fallita: ${errOf(r)}`); continue; }
    const got = new Set(r.j.items.map(i => i.name));
    const want = modelChildren(dir);
    for (const n of want) if (!got.has(n)) violation(`list(${dir || '/'}): manca "${n}"`);
    for (const n of got) if (!want.has(n)) violation(`list(${dir || '/'}): elemento inatteso "${n}"`);
  }
  // Ogni nota mostra ESATTAMENTE il contenuto del modello (anti-risurrezione).
  for (const [p, b] of M.files) {
    if (!/\.(md|txt)$/.test(p)) continue;
    const r = await sget('note_open', { path: p });
    if (!r.j?.ok) { violation(`note_open(${p}) fallita: ${errOf(r)}`); continue; }
    const txt = Buffer.from(r.j.text || '', 'base64').toString();
    if (txt !== b.content) violation(`note_open(${p}): contenuto "${txt.slice(0, 40)}" ≠ atteso "${b.content.slice(0, 40)}"`);
  }
  // Download di ogni file = byte del modello.
  for (const [p, b] of M.files) {
    const r = await req('/api.php?' + new URLSearchParams({ action: 'download', path: p }));
    const body = await r.text();
    if (r.status !== 200 || body !== b.content) violation(`download(${p}): status ${r.status} contenuto ${body === b.content ? 'ok' : 'DIVERSO'}`);
  }
  // (6) Share vive rispondono, share morte (revocate/elemento eliminato) no — via token e via indirizzo.
  for (const s of M.shares.values()) {
    for (const id of [s.token, s.slug]) {
      const r = await lpage(id);
      if (s.alive && r.status !== 200) violation(`share ${id} (${s.path}) DOVREBBE essere viva: HTTP ${r.status}`);
      if (!s.alive && r.status !== 404) violation(`share ${id} (${s.path}) dovrebbe essere MORTA: HTTP ${r.status}`);
    }
  }
  // (2) Pagina pubblica dei link di cartella: rinomina/elimina offerte esattamente
  // dove il livello lo concede (contrib: solo i file suoi e invariati).
  for (const s of M.shares.values()) {
    if (!s.alive || !s.isDir) continue;
    for (const d of [s.path, ...[...M.dirs].filter(x => x !== s.path && under(x, s.path))]) {
      const rel = relOf(s, d);
      const pg = await lpage(s.token, rel);
      if (pg.status !== 200) { violation(`pagina del link ${desc8(s.token)} p=${rel}: HTTP ${pg.status}`); continue; }
      const rows = pg.html.split('<div class="share-row"').slice(1);
      const seen = new Set();
      for (const row of rows) {
        const rrel = (/data-rel="([^"]*)"/.exec(row)?.[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const p = absOf(s, rrel);
        seen.add(p);
        const offered = row.includes('js-del');
        const want = s.mode === 'manage' || (s.mode === 'contrib' && M.files.has(p) && isOwn(s, p));
        if (offered !== want) violation(`(2) link ${s.mode} ${desc8(s.token)}: ${p} ${offered ? 'offre' : 'NON offre'} rinomina/elimina, atteso ${want ? 'sì' : 'no'}`);
      }
      for (const n of modelChildren(d)) if (!seen.has(join2(d, n))) violation(`pagina del link ${desc8(s.token)}: manca la riga ${join2(d, n)}`);
    }
  }
}

// ─── Operazioni ──────────────────────────────────────────────────────────────
let nameCounter = 0;
const usedNames = [];   // nomi già usati: per il riuso deliberato dopo una delete
const LABELS = ['Avv. Bianchi', 'Studio Rossi & C.', 'Ufficio «tecnico»', '', 'Dott.ssa Ïsabella Nuñez', 'x'.repeat(90)];
const READABLE = ['Consegna Q4', 'pratiche-2026', 'à è ì ò ù', '---'];
function slugify(s) {
  s = s.trim().toLowerCase().replace(/[àáâäã]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôöõ]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/ç/g, 'c').replace(/ñ/g, 'n').replace(/ß/g, 'ss');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  s = s.slice(0, 42).replace(/-+$/, '');
  return s || 'link';
}
const romeStamp = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
};

function makeOps(rand) {
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const chance = p => rand() < p;
  const someDir = () => pick(['', ...M.dirs]);
  const someFile = () => M.files.size ? pick([...M.files.keys()]) : null;
  const someNode = () => (M.files.size + M.dirs.size) ? pick([...M.files.keys(), ...M.dirs]) : null;
  const newName = (ext) => {
    // 1 volta su 3 RIUSA un nome già visto (è qui che vivono i bug di risurrezione)
    if (usedNames.length && rand() < 0.33) return pick(usedNames);
    // ogni tanto un nome con spazi, accenti e caratteri «da URL» (&, +, #, %, apice)
    const n = rand() < 0.06 ? `n${++nameCounter} è&'+#%${ext}` : `n${++nameCounter}${ext}`;
    usedNames.push(n);
    return n;
  };
  let seq = 0;
  const digits = n => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rand() * 10); return s; };
  // Contenuto nuovo. Sostituendo un file, spesso della STESSA lunghezza (correzione
  // di un refuso): due versioni diverse con la stessa dimensione.
  const lens = new Set();
  const content = (tag, prev = null) => {
    let c;
    if (prev !== null && chance(0.35)) {
      c = (`${tag}${++seq}-` + digits(40)).slice(0, prev.length).padEnd(prev.length, 'x');
      if (c === prev && c.length) c = c.slice(0, -1) + (c.endsWith('y') ? 'z' : 'y');
    } else c = chance(0.04) ? '' : `${tag}${++seq}-` + digits(Math.floor(rand() * 30));
    // UNIQUE_SIZES=1: ogni versione ha una lunghezza mai usata nel seed, così la
    // provenienza (dimensione+data) non può confondere due versioni nello stesso secondo.
    if (process.env.UNIQUE_SIZES === '1') { while (lens.has(c.length)) c += 'x'; lens.add(c.length); }
    return c;
  };
  const aliveDirLinks = () => [...M.shares.values()].filter(s => s.alive && s.isDir);
  // File che qualche link vivo possiede ancora: bersagli preferiti delle operazioni del proprietario.
  const linkOwned = () => [...M.files.keys()].filter(p => aliveDirLinks().some(s => under(p, s.path) && isOwn(s, p)));
  const ref = s => chance(0.3) ? s.slug : s.token;   // il link si usa sia col token sia con l'indirizzo
  const linkNodes = s => [...M.files.keys(), ...M.dirs].filter(p => p !== s.path && under(p, s.path));
  const linkSubdirs = s => [...M.dirs].filter(d => d !== s.path && under(d, s.path));
  let uidSeq = 0;
  const uid = () => (Date.now().toString(16) + (++uidSeq).toString(16).padStart(8, '0') + digits(8)).padEnd(32, '0');

  // Posti liberi legati al cestino: l'origine di una voce (il ripristino dovrà usare
  // «nome (n)») o un suo antenato (occupato da un FILE, il ripristino non è possibile).
  const trashSpots = (which) => M.trash.flatMap(e => which === 'orig' ? [e.orig] : ancestors(e.orig))
    .filter(p => !exists(p) && (parentOf(p) === '' || M.dirs.has(parentOf(p))));

  return {
    newfile: async () => {
      const spots = chance(0.15) ? trashSpots(chance(0.5) ? 'orig' : 'anc') : [];
      const spot = spots.length ? pick(spots) : null;
      const dir = spot !== null ? parentOf(spot) : someDir();
      const name = spot !== null ? baseName(spot) : newName(pick(['.md', '.txt', '.bin'])), c = content('c');
      const p = join2(dir, name);
      const r = await spost('newfile', { path: dir, name, content: c });
      if (exists(p)) { if (r.j?.ok) violation(`newfile(${p}) doveva dare conflitto`); return `newfile ${p} (conflitto ok)`; }
      if (!r.j?.ok) { violation(`newfile(${p}) fallita: ${errOf(r)}`); return; }
      M.files.set(p, newBlob(c));
      return `newfile ${p}`;
    },
    mkdir: async () => {
      const spots = chance(0.15) ? trashSpots('orig') : [];
      const spot = spots.length ? pick(spots) : null;
      const dir = spot !== null ? parentOf(spot) : someDir(), name = spot !== null ? baseName(spot) : newName('');
      const p = join2(dir, name);
      const r = await spost('mkdir', { path: dir, name });
      if (exists(p)) { if (r.j?.ok) violation(`mkdir(${p}) doveva dare conflitto`); return `mkdir ${p} (conflitto ok)`; }
      if (!r.j?.ok) { violation(`mkdir(${p}) fallita: ${errOf(r)}`); return; }
      M.dirs.add(p);
      return `mkdir ${p}`;
    },
    editNote: async () => {
      const owned = linkOwned().filter(p => /\.(md|txt)$/.test(p));
      const p = owned.length && chance(0.4) ? pick(owned) : someFile(); if (!p || !/\.(md|txt)$/.test(p)) return;
      const c = content('edit', M.files.get(p).content);
      const r = await spost('note_save', { path: p, content: c });
      if (!r.j?.ok) { violation(`note_save(${p}) fallita: ${errOf(r)}`); return; }
      M.files.set(p, newBlob(c));
      return `note_save ${p} (${c.length} B)`;
    },
    del: async () => {
      const p = someNode(); if (!p) return;
      const r = await spost('delete', { paths: [p] });
      if (!r.j?.ok || (r.j.errors || []).length) { violation(`delete(${p}): ${r.j?.errors?.join(',') || errOf(r)}`); return; }
      deleteSubtree(p);
      return `delete ${p}`;
    },
    rename: async () => {
      // rinomina del PROPRIETARIO: spesso proprio un file caricato via link
      const owned = linkOwned();
      const p = owned.length && chance(0.4) ? pick(owned) : someNode(); if (!p) return;
      if (owned.includes(p)) hit('proprietario rinomina file di un link');
      const to = newName(M.dirs.has(p) ? '' : pick(['.md', '.bin']));
      const target = join2(parentOf(p), to);
      const r = await spost('rename', { from: p, to });
      if (exists(target)) { if (r.j?.ok && target !== p) violation(`rename(${p}→${to}) doveva dare conflitto`); return `rename ${p} → ${to} (conflitto ok)`; }
      if (!r.j?.ok) { violation(`rename(${p}→${to}) fallita: ${errOf(r)}`); return; }
      renameSubtree(p, target);
      return `rename ${p} → ${target}`;
    },
    share: async () => {
      const p = someNode(); if (!p) return;
      const r = await spost('share_create', { path: p, ttl: 86400, mode: 'view', slug: '' });
      if (!r.j?.ok) { violation(`share_create(${p}) fallita: ${errOf(r)}`); return; }
      M.shares.set(r.j.token, { token: r.j.token, slug: r.j.slug, path: p, alive: true, mode: 'view', label: '', isDir: M.dirs.has(p), records: new Map() });
      return `share view ${p} → ${desc8(r.j.token)}`;
    },
    revoke: async () => {
      const alive = [...M.shares.values()].filter(s => s.alive);
      if (!alive.length) return;
      const s = pick(alive);
      const r = await spost('share_revoke', { token: s.token });
      if (!r.j?.ok) { violation(`share_revoke fallita: ${errOf(r)}`); return; }
      s.alive = false;
      return `revoke ${desc8(s.token)}`;
    },
    overwriteUpload: async () => {
      // sovrascrittura del PROPRIETARIO (upload in sessione): spesso su un file di un link
      const owned = linkOwned();
      const p = owned.length && chance(0.5) ? pick(owned) : someFile(); if (!p) return;
      if (owned.includes(p)) hit('proprietario sovrascrive file di un link');
      const dir = parentOf(p), name = baseName(p);
      const c = content('up', M.files.get(p).content);
      const body = new FormData();
      body.append('path', dir);
      body.append('files[]', new File([c], name));
      const r = await spost('upload', {}, body);
      if (!r.j?.ok || (r.j.errors || []).length) { violation(`upload(${p}): ${r.j?.errors?.join(',') || errOf(r)}`); return; }
      M.files.set(p, newBlob(c));
      return `upload-overwrite ${p} (${c.length} B)`;
    },
    shareDir: async () => {
      // link di cartella a livello casuale, nominativo («a chi lo dai»)
      const p = chance(0.08) || !M.dirs.size ? '' : pick([...M.dirs]);
      const mode = pick(['edit', 'edit', 'contrib', 'contrib', 'contrib', 'manage', 'manage', 'view']);
      const label = pick(LABELS);
      const readable = chance(0.2) ? pick(READABLE) : '';
      const st0 = romeStamp();
      const r = await spost('share_create', { path: p, ttl: 86400, mode, slug: readable, label, upload_limit_mb: 0 });
      const st1 = romeStamp();
      if (!r.j?.ok) { violation(`share_create(${mode}, ${p || '/'}) fallita: ${errOf(r)}`); return; }
      const wantLabel = [...label.replace(/[\x00-\x1F\x7F]+/g, ' ').trim()].slice(0, 80).join('');
      const m = /^(.+)-(\d{8}-\d{4})-([a-z0-9]{6})$/.exec(r.j.slug || '');
      if (!m || m[1] !== slugify(readable || (p === '' ? USER : baseName(p))) || ![st0, st1].includes(m[2]) || /[01ilo]/.test(m[3]))
        violation(`share_create: indirizzo "${r.j.slug}" non nel formato <${slugify(readable || baseName(p) || USER)}>-${st1}-<codice>`);
      if (r.j.mode !== mode || r.j.label !== wantLabel || r.j.has_pin !== false) violation(`share_create: risposta incoerente ${JSON.stringify(r.j)}`);
      M.shares.set(r.j.token, { token: r.j.token, slug: r.j.slug, path: p, alive: true, mode, label: wantLabel, isDir: true, records: new Map() });
      return `share ${mode} ${p || '/'} «${wantLabel.slice(0, 20)}» → ${desc8(r.j.token)}`;
    },
    linkUpload: async () => {
      // upload ANONIMO via link: nella radice, in una sottocartella o in una nuova;
      // spesso con un nome che COLLIDE con un file (o una cartella) già presente.
      const links = aliveDirLinks(); if (!links.length) return;
      const s = pick(links);
      const subs = linkSubdirs(s);
      let rel = '';
      const dice = rand();
      const filesIn = linkNodes(s).filter(p => M.files.has(p));
      if (dice < 0.3 && subs.length) rel = relOf(s, pick(subs));
      else if (dice < 0.4) rel = `ospite${++nameCounter}`;
      else if (dice < 0.43 && filesIn.length && s.mode !== 'view') rel = relOf(s, pick(filesIn)) + '/sotto';
      const dir = absOf(s, rel);
      if (M.files.has(dir)) return;
      // Destinazione SOTTO un file: la cartella non può esistere, l'upload deve fallire senza effetti.
      const underFile = ancestors(join2(dir, 'x')).some(a => M.files.has(a));
      const batch = [];
      const nFiles = chance(0.2) ? 2 : 1;
      for (let k = 0; k < nFiles; k++) {
        const filesHere = [...M.files.keys()].filter(f => parentOf(f) === dir);
        const dirsHere = [...M.dirs].filter(d => parentOf(d) === dir);
        const d2 = rand();
        let name;
        if (k === 1 && chance(0.5)) name = batch[0].name;             // stesso nome due volte nello stesso invio
        else if (d2 < 0.45 && filesHere.length) name = baseName(pick(filesHere));
        else if (d2 < 0.5 && dirsHere.length) name = baseName(pick(dirsHere));
        else name = newName(pick(['.md', '.txt', '.bin', '']));
        const prev = M.files.get(join2(dir, name)) || (k === 1 ? { content: batch[0].content } : null);
        batch.push({ name, content: content('link', prev ? prev.content : null) });
      }
      const chunked = nFiles === 1 && chance(0.35);
      const send = async () => {
        if (!chunked) {
          const body = new FormData();
          body.append('path', rel);
          for (const f of batch) body.append('files[]', new File([f.content], f.name));
          return [await lpost('upload', ref(s), {}, body)];
        }
        const f = batch[0], id = uid(), len = Buffer.byteLength(f.content), out = [];
        if (len > 0) {
          const body = new FormData();
          for (const [k, v] of Object.entries({ uid: id, index: 0, offset: 0, chunk_size: len, total: len, path: rel, name: f.name })) body.append(k, String(v));
          body.append('chunk', new File([f.content], 'blob'));
          out.push(await lpost('upload_chunk', ref(s), {}, body));
          if (!out[0].j?.ok) return out;
        }
        out.push(await lpost('upload_finish', ref(s), { uid: id, name: f.name, total: len, chunk_size: len || 1048576, path: rel }));
        return out;
      };
      const what = `link-upload ${s.mode} ${desc8(s.token)} ${chunked ? '(a blocchi) ' : ''}${batch.map(f => join2(dir, f.name)).join(' + ')}`;
      if (s.mode === 'view') {
        const rs = await send();
        if (rs[0].status !== 403 || rs[0].j?.ok) violation(`${what}: un link in sola lettura doveva ricevere 403, invece ${errOf(rs[0])}`);
        hit('upload view 403');
        return `${what} → 403 ok`;
      }
      const guard = foreignGuard(s, 'upload');
      const mark = auditSize();
      if (underFile) {
        hit('upload sotto un file');
        const rs = await send();
        const last = rs[rs.length - 1];
        if (last.j?.ok && (chunked || last.j.saved > 0)) violation(`${what}: la destinazione è sotto un file, l'upload doveva fallire (${JSON.stringify(last.j)})`);
        guard();
        return `${what} → rifiutato (sotto un file) ok`;
      }
      // Il modello applica il batch in ordine, come il server.
      const expect = [];
      for (const f of batch) {
        const t = uploadTarget(s, dir, f.name);
        if (t.replace) toTrash(t.path, actor(s));
        ensureDirs(parentOf(t.path));
        const b = newBlob(f.content);
        M.files.set(t.path, b);
        s.records.set(relOf(s, t.path), b.id);
        expect.push(baseName(t.path) + (t.replace ? ' (sostituito)' : ''));
        hit(`upload ${s.mode} ${t.replace ? 'sostituisce' : (baseName(t.path) !== f.name ? 'rinomina' : 'nuovo')}`);
      }
      const names = expect.map(n => n.replace(/ \(sostituito\)$/, ''));
      const rs = await send();
      const last = rs[rs.length - 1];
      if (!last.j?.ok || rs.some(x => !x.j?.ok) || (last.j.errors || []).length) { violation(`${what}: ${last.j?.errors?.join(',') || errOf(last)}`); return; }
      const got = chunked ? [last.j.name] : last.j.names;
      if (JSON.stringify(got) !== JSON.stringify(names)) violation(`${what}: salvato come ${JSON.stringify(got)}, atteso ${JSON.stringify(names)}`);
      if (chunked && last.j.renamed !== (names[0] !== batch[0].name)) violation(`${what}: renamed=${last.j.renamed} incoerente`);
      guard();
      auditExpect(mark, 'link_upload', s);
      return `${what} → ${expect.join(', ')}`;
    },
    linkDelete: async () => {
      const links = aliveDirLinks(); if (!links.length) return;
      const s = pick(links);
      const own = linkNodes(s).filter(p => isOwn(s, p));
      const nodes = linkNodes(s);
      const paths = [];
      for (let k = chance(0.15) ? 2 : 1; k > 0; k--) {
        const d = rand();
        if (d < 0.06) paths.push(pick(['', '.', '/']));               // la radice del link: mai eliminabile
        else if (d < 0.5 && own.length) paths.push(relOf(s, pick(own)));
        else if (nodes.length) paths.push(relOf(s, pick(nodes)));
      }
      if (!paths.length) return;
      // Un percorso NON valido in mezzo agli altri: o la richiesta è rifiutata per
      // intero senza effetti, o quel percorso diventa un errore come gli altri.
      const bad = chance(0.08) ? pick(['../fuori', 'x/../../fuori', 'nome\u0001']) : null;
      if (bad !== null) paths.splice(Math.floor(rand() * (paths.length + 1)), 0, bad);
      const what = `link-delete ${s.mode} ${desc8(s.token)} [${paths.map(x => x === bad ? JSON.stringify(bad) : (absOf(s, x) || '/')).join(', ')}]`;
      if (s.mode !== 'contrib' && s.mode !== 'manage') {
        const r = await lpost('link_delete', ref(s), { paths });
        if (r.status !== 403 || r.j?.ok) violation(`${what}: atteso 403 per il livello ${s.mode}, invece ${errOf(r)}`);
        return `${what} → 403 ok`;
      }
      const guard = foreignGuard(s, 'eliminazione');
      const mark = auditSize();
      const snap = snapModel();
      let expDel = 0, expErr = 0;
      const removed = [], outcome = [];
      for (const rel of paths) {
        if (rel === bad) { expErr++; outcome.push('non valido'); continue; }
        const p = ['', '.', '/'].includes(rel) ? s.path : absOf(s, rel);
        if (p === s.path || !exists(p) || !mayTouch(s, p)) { expErr++; outcome.push('rifiutato'); hit(`delete ${s.mode} rifiutato`); continue; }
        hit(`delete ${s.mode} ${M.dirs.has(p) ? 'cartella' : (isOwn(s, p) ? 'file proprio' : 'file altrui')}`);
        toTrash(p, actor(s));
        s.records.delete(relOf(s, p));
        removed.push(p); expDel++; outcome.push('cestino');
      }
      for (const p of removed) revokeUnder(p);
      const r = await lpost('link_delete', ref(s), { paths });
      if (bad !== null && r.status === 400 && r.j && !r.j.ok) {
        hit('delete percorso non valido → 400');
        restoreModel(snap);   // rifiuto per intero: nulla deve essere cambiato (lo verificano i controlli del passo)
        guard();
        return `${what} → 400 (nessun effetto atteso)`;
      }
      if (bad !== null) hit('delete percorso non valido → errore per voce');
      if (!r.j?.ok) { violation(`${what}: ${errOf(r)}`); return; }
      if (r.j.deleted !== expDel || (r.j.errors || []).length !== expErr)
        violation(`${what}: eliminati ${r.j.deleted} (errori ${JSON.stringify(r.j.errors)}), attesi ${expDel} eliminati e ${expErr} rifiuti`);
      guard();
      if (expDel) auditExpect(mark, 'link_delete', s);
      return `${what} → ${outcome.join(', ')}`;
    },
    linkRename: async () => {
      const links = aliveDirLinks(); if (!links.length) return;
      const s = pick(links);
      const own = linkNodes(s).filter(p => isOwn(s, p));
      const nodes = linkNodes(s);
      const d = rand();
      const from = d < 0.05 ? s.path : (d < 0.5 && own.length ? pick(own) : (nodes.length ? pick(nodes) : null));
      if (from === null) return;
      const siblings = [...modelChildren(parentOf(from))].filter(n => from === s.path || n !== baseName(from));
      const d2 = rand();
      const to = from !== s.path && d2 < 0.05 ? baseName(from)
        : (d2 < 0.2 && siblings.length ? pick(siblings) : newName(M.dirs.has(from) ? '' : pick(['.md', '.bin', '.txt'])));
      const what = `link-rename ${s.mode} ${desc8(s.token)} ${from || '/'} → ${to}`;
      const r0 = { from: relOf(s, from), to };
      let expStatus = 200;
      if (s.mode !== 'contrib' && s.mode !== 'manage') expStatus = 403;
      else if (from === s.path) expStatus = 400;
      else if (s.mode === 'contrib' && !(M.files.has(from) && isOwn(s, from))) expStatus = 403;
      const target = join2(parentOf(from), to);
      if (expStatus === 200 && target !== from && exists(target)) expStatus = 409;
      hit(`rename ${s.mode} ${expStatus}`);
      const guard = expStatus === 200 ? foreignGuard(s, 'rinomina') : () => {};
      const mark = auditSize();
      const r = await lpost('link_rename', ref(s), r0);
      if (expStatus !== 200) {
        if (r.status !== expStatus || r.j?.ok) violation(`${what}: atteso HTTP ${expStatus}, invece ${errOf(r)}`);
        return `${what} → ${expStatus} ok`;
      }
      if (!r.j?.ok) { violation(`${what}: ${errOf(r)}`); return; }
      if (target === from) return `${what} → stesso nome ok`;
      const ownBefore = M.files.has(from) && isOwn(s, from);
      renameSubtree(from, target);
      if (ownBefore) { const id = s.records.get(relOf(s, from)); s.records.delete(relOf(s, from)); s.records.set(relOf(s, target), id); }
      guard();
      auditExpect(mark, 'link_rename', s);
      return `${what} → ok`;
    },
    linkMkdir: async () => {
      const links = aliveDirLinks(); if (!links.length) return;
      const s = pick(links);
      const parent = pick([s.path, ...linkSubdirs(s)]);
      const kids = [...modelChildren(parent)];
      const name = kids.length && chance(0.2) ? pick(kids) : newName('');
      const p = join2(parent, name);
      const what = `link-mkdir ${s.mode} ${desc8(s.token)} ${p}`;
      const expStatus = (s.mode !== 'contrib' && s.mode !== 'manage') ? 403 : (exists(p) ? 409 : 200);
      hit(`mkdir ${s.mode} ${expStatus}`);
      const guard = expStatus === 200 ? foreignGuard(s, 'nuova cartella') : () => {};
      const mark = auditSize();
      const r = await lpost('link_mkdir', ref(s), { path: relOf(s, parent), name });
      if (expStatus !== 200) {
        if (r.status !== expStatus || r.j?.ok) violation(`${what}: atteso HTTP ${expStatus}, invece ${errOf(r)}`);
        return `${what} → ${expStatus} ok`;
      }
      if (!r.j?.ok) { violation(`${what}: ${errOf(r)}`); return; }
      M.dirs.add(p);
      guard();
      auditExpect(mark, 'link_mkdir', s);
      return `${what} → ok`;
    },
    deadLink: async () => {
      // Un link MORTO (revocato, o la cui cartella è stata eliminata) non deve più
      // operare, nemmeno se nel frattempo è ricomparsa una cartella con lo stesso nome.
      const dead = [...M.shares.values()].filter(s => !s.alive && s.isDir);
      if (!dead.length) return;
      const s = pick(dead);
      const action = pick(['upload', 'link_mkdir', 'link_delete', 'link_rename']);
      const t = ref(s);
      let r;
      if (action === 'upload') {
        const body = new FormData();
        body.append('path', '');
        body.append('files[]', new File(['morto'], newName('.txt')));
        r = await lpost('upload', t, {}, body);
      } else if (action === 'link_mkdir') r = await lpost(action, t, { path: '', name: newName('') });
      else if (action === 'link_delete') r = await lpost(action, t, { paths: [pick([...modelChildren(s.path), 'x'])] });
      else r = await lpost(action, t, { from: pick([...modelChildren(s.path), 'x']), to: newName('.md') });
      hit('link morto');
      if (r.status !== 404 || r.j?.ok) violation(`${action} via link morto ${desc8(s.token)} (${s.path}): atteso 404, invece ${errOf(r)}`);
      return `${action} via link morto ${desc8(s.token)} → 404 ok`;
    },
    linkNote: async () => {
      // Il token di una CARTELLA non apre né salva le note che contiene (solo i link di file).
      const links = aliveDirLinks().filter(s => s.mode !== 'view');
      if (!links.length) return;
      const s = pick(links);
      const notes = [...M.files.keys()].filter(p => under(p, s.path) && /\.(md|txt)$/.test(p));
      if (!notes.length) return;
      const p = pick(notes);
      const guard = foreignGuard(s, 'note_save');
      const r = await lpost('note_save', ref(s), { path: relOf(s, p), content: 'scritto dal link di cartella' });
      hit('note via link di cartella');
      if (r.j?.ok) violation(`note_save via link di cartella ${s.mode} ${desc8(s.token)} su ${p}: doveva essere rifiutato`);
      guard();
      return `note_save via link di cartella ${s.mode} su ${p} → rifiutato ok`;
    },
    trashRestore: async () => {
      const ready = M.trash.filter(e => e.id);
      if (!ready.length || chance(0.05)) {
        const r = await spost('trash_restore', { id: 'ffffffffffffffff' });
        if (r.status !== 404 || r.j?.ok) violation(`trash_restore(id inesistente): atteso 404, invece ${errOf(r)}`);
        return 'trash_restore id inesistente → 404 ok';
      }
      const e = pick(ready);
      const t = restoreTarget(e);
      hit(`restore ${e.type} ${t.blocked ? 'bloccato' : (t.path === e.orig ? 'origine' : 'nome (n)')}`);
      const r = await spost('trash_restore', { id: e.id });
      if (t.blocked) {
        if (r.j?.ok) violation(`trash_restore(${e.orig}): un antenato è un file, il ripristino doveva fallire (risposta ${JSON.stringify(r.j)})`);
        return `trash_restore ${e.orig} → bloccato (antenato file) ok`;
      }
      if (!r.j?.ok) { violation(`trash_restore(${e.orig}): ${errOf(r)}`); return; }
      if (r.j.path !== t.path) violation(`trash_restore(${e.orig}): ripristinato in "${r.j.path}", atteso "${t.path}"`);
      M.trash.splice(M.trash.indexOf(e), 1);
      ensureDirs(parentOf(t.path));
      if (e.type === 'file') M.files.set(t.path, e.files.get(''));
      else {
        M.dirs.add(t.path);
        for (const d of e.dirs) M.dirs.add(join2(t.path, d));
        for (const [k, b] of e.files) M.files.set(join2(t.path, k), b);
      }
      return `trash_restore ${e.type} ${e.orig} → ${t.path}`;
    },
    trashPurge: async () => {
      if (chance(0.15)) {
        const n = M.trash.length;
        hit('purge tutto');
        const r = await spost('trash_purge', { all: 1 });
        if (!r.j?.ok || r.j.purged !== n) violation(`trash_purge(all): purged ${r.j?.purged} ≠ ${n} (${errOf(r)})`);
        M.trash = [];
        return `trash_purge all (${n})`;
      }
      const ready = M.trash.filter(e => e.id);
      if (!ready.length || chance(0.05)) {
        const r = await spost('trash_purge', { id: 'ffffffffffffffff' });
        if (r.status !== 404 || r.j?.ok) violation(`trash_purge(id inesistente): atteso 404, invece ${errOf(r)}`);
        return 'trash_purge id inesistente → 404 ok';
      }
      const e = pick(ready);
      hit('purge voce');
      const r = await spost('trash_purge', { id: e.id });
      if (!r.j?.ok || r.j.purged !== 1) { violation(`trash_purge(${e.orig}): ${errOf(r)}`); return; }
      M.trash.splice(M.trash.indexOf(e), 1);
      return `trash_purge ${e.type} ${e.orig}`;
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
const seeds = process.env.SEEDS ? process.env.SEEDS.trim().split(/\s+/).map(Number) : [Number(process.argv[2] || 1)];
const N = Number(process.env.OPS || process.argv[3] || 120);
const WEIGHTS = {
  newfile: 3, mkdir: 2, editNote: 2, del: 2, rename: 2, share: 1, revoke: 1, overwriteUpload: 2,
  shareDir: 2, linkUpload: 5, linkDelete: 3, linkRename: 3, linkMkdir: 2, trashRestore: 2, trashPurge: 1,
  deadLink: 1, linkNote: 1,
};
const failedSeeds = [];
for (const seed of seeds) {
  await startWorld();
  resetModel(); usedNames.length = 0; nameCounter = 0; seedFailed = false;
  const oplog = [];
  const rand = rng(seed);
  const ops = makeOps(rand);
  const bag = Object.keys(ops).flatMap(k => Array(WEIGHTS[k] || 1).fill(k));
  console.log(`— seed ${seed}: ${N} operazioni`);
  for (let i = 0; i < N; i++) {
    CUR = { seed, step: i };
    const op = bag[Math.floor(rand() * bag.length)];
    try {
      const desc = await ops[op]();
      if (desc) oplog.push(`${i}: ${desc}`);
      if (!seedFailed) await checkStep();
      if (!seedFailed && (i % 10 === 9 || i === N - 1)) await checkDeep();
    } catch (e) { violation(`eccezione durante ${op}: ${e.stack || e}`); }
    if (seedFailed) break;
  }
  if (seedFailed) {
    failedSeeds.push(seed);
    console.log(`\nSEQUENZA (seed ${seed}) che ha portato alla violazione:`);
    console.log(oplog.join('\n'));
    if (phpLog.length) console.log('\nUltimi messaggi di php -S:\n' + phpLog.join('\n'));
  } else console.log(`  ✓ seed ${seed}: ${N} operazioni, invarianti sempre rispettate`);
  await stopWorld(seedFailed && !!process.env.KEEP);
}
console.log('\nCopertura: ' + [...cov].sort().map(([k, n]) => `${k}=${n}`).join(' · '));
console.log(failedSeeds.length ? `\nFALLITO: ${fails.length} violazioni (seed ${failedSeeds.join(', ')})` : '\nTUTTE LE INVARIANTI RISPETTATE ✓');
process.exit(failedSeeds.length ? 1 : 0);
