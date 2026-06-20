// util.js — utility pure / di presentazione (modulo foglia, nessun import interno).

export function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg; document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2600);
}

export function iconFor(it) {
  if (it.type === 'dir') return 'ti-folder ico-dir';
  const ext = (it.name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'ti-photo', jpeg: 'ti-photo', png: 'ti-photo', gif: 'ti-photo', webp: 'ti-photo', svg: 'ti-photo',
    pdf: 'ti-file-type-pdf', doc: 'ti-file-type-doc', docx: 'ti-file-type-doc',
    xls: 'ti-file-type-xls', xlsx: 'ti-file-type-xls', csv: 'ti-file-type-csv',
    zip: 'ti-file-zip', rar: 'ti-file-zip', '7z': 'ti-file-zip', gz: 'ti-file-zip', tar: 'ti-file-zip',
    mp3: 'ti-music', wav: 'ti-music', mp4: 'ti-video', mov: 'ti-video',
    txt: 'ti-file-text', md: 'ti-file-text', php: 'ti-file-code', js: 'ti-file-code', html: 'ti-file-code', css: 'ti-file-code', json: 'ti-file-code',
  };
  return (map[ext] || 'ti-file') + ' ico-file';
}

export function fmtBytes(b) { if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1, v = b; do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1); return v.toFixed(1) + ' ' + u[i]; }

export function fmtTime(iso) { try { return new Date(iso).toLocaleString('it-IT'); } catch (_) { return iso; } }

export function copyText(t) {
  try { navigator.clipboard.writeText(t); }
  catch (_) { const i = document.createElement('textarea'); i.value = t; document.body.appendChild(i); i.select(); try { document.execCommand('copy'); } catch (e) {} i.remove(); }
}

export function fmtDuration(s) {
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  if (d > 0) return d + 'g ' + h + 'h'; if (h > 0) return h + 'h ' + m + 'm'; if (m > 0) return m + 'm ' + x + 's'; return x + 's';
}

const BIN_EXT = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','svgz','pdf','zip','rar','7z','gz','tgz','tar','bz2','mp3','wav','ogg','flac','mp4','mov','avi','mkv','webm','exe','dll','so','bin','dat','class','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','woff','woff2','ttf','otf','eot','psd','ai','eps']);
export function isTextFile(name) { return !BIN_EXT.has((name.split('.').pop() || '').toLowerCase()); }
export const b64ToU8 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));

export function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Normalizza un titolo in uno slug per l'URL (coerente con share_slugify() lato PHP):
// minuscole, accenti rimossi, solo [a-z0-9-], niente trattini doppi/agli estremi, max 64.
export function slugify(s) {
  return String(s).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
