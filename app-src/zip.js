// zip.js — download ZIP: client-side diretto da S3 (presigned) con fallback server-zip.
import { JSZIP_V } from './state.js';
import { toast } from './util.js';

// Download senza lasciare l'app: la risposta va in un iframe nascosto. Un file
// (Content-Disposition: attachment, o redirect verso S3) parte come download e
// l'iframe non carica nulla di leggibile; un errore JSON di api.php (file sparito,
// sessione scaduta) si carica nell'iframe e diventa un toast. Niente fetch: uno ZIP
// grande va dritto su disco, non in memoria.
let dlSeq = 0;
export function downloadInFrame(url, fields = null) {
  const f = document.createElement('iframe');
  f.name = 'dl' + (++dlSeq) + '_' + Date.now();
  f.hidden = true; f.setAttribute('aria-hidden', 'true');
  document.body.appendChild(f);
  f.onload = () => {
    let txt = null;
    try {
      const d = f.contentDocument;   // null/eccezione se la risposta è di un'altra origine (S3)
      if (d && d.location.href !== 'about:blank') txt = d.body ? d.body.textContent : '';
    } catch (_) {}
    if (txt === null) return;
    let err = '';
    try { err = JSON.parse(txt).error || ''; } catch (_) {}
    toast('Download non riuscito: ' + (err || 'errore del server'), true);
    setTimeout(() => f.remove(), 0);
  };
  // I download andati a buon fine non generano load: l'iframe si toglie più tardi
  // (uno ZIP grande può impiegare minuti prima di iniziare).
  setTimeout(() => f.remove(), 30 * 60 * 1000);
  if (!fields) { f.src = url; return; }
  const form = document.createElement('form');
  form.method = 'POST'; form.action = url; form.target = f.name; form.style.display = 'none';
  for (const [k, v] of fields) {
    const i = document.createElement('input');
    i.type = 'hidden'; i.name = k; i.value = v;
    form.appendChild(i);
  }
  document.body.appendChild(form); form.submit(); form.remove();
}

export function downloadZip(paths) {
  if (!paths.length) { toast('Niente da scaricare', true); return; }
  // Form POST (non GET): con selezioni ampie l'elenco paths[] in GET supererebbe
  // la request line del server (414/400).
  downloadInFrame('api.php?action=zip', paths.map(p => ['paths[]', p]));
}

// Carica JSZip in locale (vendorizzato, lazy: un solo <script> al primo uso).
let _jszipLoading = null;
export function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (_jszipLoading) return _jszipLoading;
  _jszipLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'assets/vendor/jszip.min.js?v=' + JSZIP_V;
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip non disponibile'));
    s.onerror = () => reject(new Error('Impossibile caricare JSZip'));
    document.head.appendChild(s);
  });
  return _jszipLoading;
}

// Costruisce lo ZIP nel BROWSER scaricando ogni file DIRETTAMENTE da Wasabi
// (presigned GET). Su qualsiasi errore (rete/CORS/JSZip) → fallback server-zip
// trasparente: l'esperienza utente non cambia.
export async function clientZip(manifest) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  for (const f of manifest.files) {
    if (!f.url) { zip.folder(f.name.replace(/\/$/, '')); continue; }   // marker cartella vuota
    const r = await fetch(f.url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + f.name);
    zip.file(f.name, await r.blob(), { compression: 'STORE' });        // STORE: niente ricompressione
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a = document.createElement('a');
  const u = URL.createObjectURL(blob);
  a.href = u; a.download = manifest.zipname || 'download.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}

// Entry point dei download ZIP: prova il client-zip (banda server ~zero su S3),
// con fallback automatico al server-zip su mode:'server' o qualsiasi errore.
export async function startZip(paths) {
  if (!paths.length) { toast('Niente da scaricare', true); return; }
  let manifest = null;
  try {
    const fd = new FormData();
    paths.forEach(p => fd.append('paths[]', p));   // POST: nessun limite di lunghezza URL
    const r = await fetch('api.php?action=zip_manifest', { method: 'POST', body: fd });
    manifest = await r.json();
  } catch (_) { manifest = null; }
  if (!manifest || !manifest.ok || manifest.mode !== 'client' || !Array.isArray(manifest.files)) {
    downloadZip(paths); return;                                        // server-zip (locale o oltre i limiti)
  }
  try {
    toast('Preparazione ZIP…');
    await clientZip(manifest);
  } catch (e) {
    downloadZip(paths);                                               // CORS/rete/JSZip → server-zip
  }
}
