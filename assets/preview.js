// Anteprima dei documenti NEL BROWSER (app e pagina pubblica dei link): PDF
// (PDF.js), Markdown, testo, DOCX (docx-preview), RTF (rtf.js), fogli di calcolo
// (SheetJS). Il server non converte nulla: scarica il file com'è (S3: direttamente
// da Wasabi via URL presigned + CORS) e lo disegna qui. Le librerie stanno in
// assets/vendor/preview e si caricano solo al primo uso del formato.
// L'HTML generato dai documenti va in un iframe sandbox SENZA script: un link
// javascript: o un attributo on* dentro un file non possono eseguire codice.
// Espone window.Preview = { kindOf(name), open({url, name, size, onEdit}) }.
// I formati sono replicati in PHP da preview_kind() (share.php): tenerli allineati.
(function () {
  const VENDOR = new URL('assets/vendor/preview/', document.baseURI).href;
  const JSZIP = new URL('assets/vendor/jszip.min.js', document.baseURI).href;
  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_TEXT = 2 * 1024 * 1024;
  const MAX_PAGES = 300;
  const MAX_ROWS = 2000;
  const KINDS = {
    pdf: 'pdf', md: 'md', markdown: 'md', txt: 'txt', log: 'txt', docx: 'docx', rtf: 'rtf',
    xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet', doc: 'doc',
  };
  const kindOf = name => KINDS[(String(name).split('.').pop() || '').toLowerCase()] || null;

  const loaded = {};
  function script(src) {
    return loaded[src] || (loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('libreria di anteprima non caricata')); };
      document.head.appendChild(s);
    }));
  }
  const lib = f => script(VENDOR + f);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = b => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + u[i]; };

  // Il browser legge il file direttamente (redirect verso Wasabi con CORS). Se non
  // ci riesce (CORS assente, rete), lo chiede al server con via=server.
  async function fetchBytes(url) {
    url += (url.includes('?') ? '&' : '?') + 'purpose=preview';   // nel registro degli accessi: anteprima, non download
    let r;
    try { r = await fetch(url, { credentials: 'same-origin' }); } catch (_) { r = null; }
    if (!r || !r.ok) {
      const alt = url + (url.includes('?') ? '&' : '?') + 'via=server';
      try { r = await fetch(alt, { credentials: 'same-origin' }); } catch (_) { throw new Error('connessione non riuscita'); }
      if (!r.ok) throw new Error(r.status === 401 ? 'accesso non consentito (PIN?)' : 'file non disponibile (HTTP ' + r.status + ')');
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('file troppo grande per l\'anteprima');
    return r.arrayBuffer();
  }

  // iframe isolato: allow-same-origin per poterci scrivere dal genitore, niente
  // allow-scripts (nessun codice del documento può girare), niente popup né navigazione.
  function frame(body) {
    return new Promise(res => {
      const f = document.createElement('iframe');
      f.className = 'pv-frame';
      f.setAttribute('sandbox', 'allow-same-origin');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>'
        + 'body{font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2328;margin:0;padding:24px;background:#fff;word-wrap:break-word}'
        + 'img{max-width:100%}pre,code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f8fa;border-radius:4px}pre{padding:12px;overflow:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;white-space:nowrap}'
        + 'blockquote{border-left:4px solid #d0d7de;margin:0;padding:0 12px;color:#57606a}.md{max-width:860px;margin:0 auto}'
        + '</style></head><body></body></html>';
      f.onload = () => res(f.contentDocument);
      body.appendChild(f);
    });
  }

  const RENDER = {
    async txt(ab, body) {
      const pre = document.createElement('pre');
      pre.className = 'pv-text';
      const cut = ab.byteLength > MAX_TEXT;
      pre.textContent = new TextDecoder().decode(cut ? ab.slice(0, MAX_TEXT) : ab) + (cut ? '\n\n… (anteprima troncata a ' + fmt(MAX_TEXT) + ')' : '');
      body.appendChild(pre);
    },
    async md(ab, body) {
      await Promise.all([lib('marked.umd.js'), lib('purify.min.js')]);
      const html = window.DOMPurify.sanitize(window.marked.parse(new TextDecoder().decode(ab)));
      const doc = await frame(body);
      doc.body.innerHTML = '<div class="md">' + html + '</div>';
    },
    async pdf(ab, body) {
      const pdfjs = await import(VENDOR + 'pdf.min.js');
      pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(ab), isEvalSupported: false, enableXfa: false }).promise;
      const wrap = document.createElement('div');
      wrap.className = 'pv-pages';
      body.appendChild(wrap);
      const n = Math.min(pdf.numPages, MAX_PAGES);
      for (let i = 1; i <= n; i++) {
        if (!wrap.isConnected) return;                       // anteprima chiusa nel frattempo
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.max(0.5, (wrap.clientWidth - 24) / base.width));
        const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        c.style.width = (vp.width / (window.devicePixelRatio || 1)) + 'px';
        wrap.appendChild(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
      if (pdf.numPages > n) note(body, 'Mostrate le prime ' + n + ' pagine su ' + pdf.numPages + ': scarica il file per vederlo tutto.');
    },
    async docx(ab, body) {
      await script(JSZIP);
      await lib('docx-preview.min.js');
      const doc = await frame(body);
      await window.docx.renderAsync(ab, doc.body, doc.head, { inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, renderComments: false });
      note(body, 'Anteprima approssimata: impaginazione e caratteri possono differire dall\'originale.');
    },
    async rtf(ab, body) {
      await lib('EMFJS.bundle.min.js'); await lib('WMFJS.bundle.min.js'); await lib('RTFJS.bundle.min.js');
      window.RTFJS.loggingEnabled(false); window.WMFJS.loggingEnabled(false); window.EMFJS.loggingEnabled(false);
      const els = await new window.RTFJS.Document(ab).render();
      const doc = await frame(body);
      els.forEach(e => doc.body.appendChild(doc.adoptNode(e)));
      note(body, 'Anteprima approssimata: impaginazione e caratteri possono differire dall\'originale.');
    },
    async sheet(ab, body, name) {
      await Promise.all([lib('xlsx.full.min.js'), lib('purify.min.js')]);
      const X = window.XLSX;
      const wb = /\.csv$/i.test(name) ? X.read(new TextDecoder().decode(ab), { type: 'string', raw: true }) : X.read(ab, { type: 'array', cellFormula: false, cellHTML: false });
      const tabs = document.createElement('div');
      tabs.className = 'pv-tabs';
      const host = document.createElement('div');
      host.className = 'pv-sheet';
      body.append(tabs, host);
      const doc = await frame(host);
      const show = (sn, btn) => {
        tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        const ws = wb.Sheets[sn];
        let cut = '';
        if (ws && ws['!ref']) {
          const r = X.utils.decode_range(ws['!ref']);
          if (r.e.r - r.s.r + 1 > MAX_ROWS) { cut = '<p>Mostrate le prime ' + MAX_ROWS + ' righe su ' + (r.e.r - r.s.r + 1) + '.</p>'; r.e.r = r.s.r + MAX_ROWS - 1; ws['!ref'] = X.utils.encode_range(r); }
        }
        const html = ws && ws['!ref'] ? X.utils.sheet_to_html(ws, { header: '', footer: '' }) : '<p>Foglio vuoto.</p>';
        doc.body.innerHTML = window.DOMPurify.sanitize(cut + html);
      };
      wb.SheetNames.forEach((sn, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = sn;
        b.onclick = () => show(sn, b);
        tabs.appendChild(b);
        if (i === 0) show(sn, b);
      });
      if (wb.SheetNames.length < 2) tabs.hidden = true;
      note(body, 'Anteprima dei dati: formule, grafici e formattazione non sono riprodotti.');
    },
  };
  function note(body, text) {
    const p = document.createElement('p');
    p.className = 'pv-note';
    p.textContent = text;
    body.appendChild(p);
  }

  let current = null;
  function close() {
    if (!current) return;
    current.remove(); current = null;
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  async function open(o) {
    close();
    const kind = kindOf(o.name);
    const el = document.createElement('div');
    el.className = 'pv-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Anteprima di ' + o.name);
    el.innerHTML = '<div class="pv-head"><span class="pv-title" title="' + esc(o.name) + '">' + esc(o.name) + '</span>'
      + (o.onEdit ? '<button type="button" class="btn pv-edit"><i class="ti ti-edit"></i> Modifica</button>' : '')
      + '<a class="btn pv-dl" href="' + esc(o.url) + '"><i class="ti ti-download"></i> Scarica</a>'
      + '<button type="button" class="btn pv-close" aria-label="Chiudi"><i class="ti ti-x"></i></button></div>'
      + '<div class="pv-body"><p class="pv-msg">Apertura…</p></div>';
    document.body.appendChild(el);
    current = el;
    document.addEventListener('keydown', onKey, true);
    el.querySelector('.pv-close').onclick = close;
    if (o.onEdit) el.querySelector('.pv-edit').onclick = () => { close(); o.onEdit(); };
    const body = el.querySelector('.pv-body'), msg = el.querySelector('.pv-msg');
    if (kind === 'doc') { msg.textContent = 'L\'anteprima non è disponibile per i documenti .doc (Word 97-2003): scarica il file.'; return; }
    if (!kind || !RENDER[kind]) { msg.textContent = 'Anteprima non disponibile per questo tipo di file.'; return; }
    if (o.size && o.size > MAX_BYTES) { msg.textContent = 'File troppo grande per l\'anteprima (' + fmt(o.size) + '): scaricalo.'; return; }
    try {
      const ab = await fetchBytes(o.url);
      if (current !== el) return;
      msg.remove();
      await RENDER[kind](ab, body, o.name);
    } catch (e) {
      if (current !== el) return;
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'pv-msg';
      p.textContent = 'Anteprima non riuscita: ' + ((e && e.message) || e) + '. Puoi scaricare il file.';
      body.appendChild(p);
    }
  }

  window.Preview = { kindOf, open, close };
})();
