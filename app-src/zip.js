// zip.js — download ZIP: client-side diretto da S3 (presigned) con fallback server-zip.
import { JSZIP_V } from './state.js';
import { toast } from './util.js';

export function downloadZip(paths) {
  if (!paths.length) { toast('Niente da scaricare', true); return; }
  const q = new URLSearchParams();
  q.set('action', 'zip');
  paths.forEach(p => q.append('paths[]', p));
  window.location = 'api.php?' + q.toString();
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
    const q = new URLSearchParams();
    q.set('action', 'zip_manifest');
    paths.forEach(p => q.append('paths[]', p));
    const r = await fetch('api.php?' + q.toString());
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
