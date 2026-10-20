/* desoshare — app.js GENERATO da app-src/ via esbuild (npm run build). NON modificare a mano. */
(() => {
  // state.js
  var app = document.getElementById("app");
  var CSRF = app.dataset.csrf;
  var CAN_WRITE = app.dataset.write === "1";
  var IS_ADMIN = app.dataset.admin === "1";
  var EDITOR_BUNDLE_V = app.dataset.edv || "1";
  var JSZIP_V = app.dataset.jszipv || "1";
  var APP_VERSION = app.dataset.version || "";
  var VIEW = app.dataset.view || "files";
  var USER = app.dataset.user || "";
  var S = {
    cwd: "",
    // percorso corrente (relativo alla radice)
    items: [],
    // elementi della cartella corrente
    shareTimer: null,
    // intervallo del conto alla rovescia nel pannello condivisioni
    editorCleanup: null
    // funzione di chiusura dell'editor note (stop sync/save)
  };
  var selected = /* @__PURE__ */ new Set();
  var $ = (s, r = document) => r.querySelector(s);
  var rowsEl = $("#rows");
  var emptyEl = $("#empty");
  var crumbsEl = $("#crumbs");
  var selbar = $("#selbar");
  var selCount = $("#selCount");
  var searchEl = $("#search");
  var modalBg = $("#modalBg");

  // util.js
  function toast(msg, isErr = false) {
    const t = document.createElement("div");
    t.className = "toast" + (isErr ? " err" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }
  function iconFor(it) {
    if (it.type === "dir") return "ti-folder ico-dir";
    const ext = (it.name.split(".").pop() || "").toLowerCase();
    const map = {
      jpg: "ti-photo",
      jpeg: "ti-photo",
      png: "ti-photo",
      gif: "ti-photo",
      webp: "ti-photo",
      svg: "ti-photo",
      pdf: "ti-file-type-pdf",
      doc: "ti-file-type-doc",
      docx: "ti-file-type-doc",
      xls: "ti-file-type-xls",
      xlsx: "ti-file-type-xls",
      csv: "ti-file-type-csv",
      zip: "ti-file-zip",
      rar: "ti-file-zip",
      "7z": "ti-file-zip",
      gz: "ti-file-zip",
      tar: "ti-file-zip",
      mp3: "ti-music",
      wav: "ti-music",
      mp4: "ti-video",
      mov: "ti-video",
      txt: "ti-file-text",
      md: "ti-file-text",
      php: "ti-file-code",
      js: "ti-file-code",
      html: "ti-file-code",
      css: "ti-file-code",
      json: "ti-file-code"
    };
    return (map[ext] || "ti-file") + " ico-file";
  }
  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1, v = b;
    do {
      v /= 1024;
      i++;
    } while (v >= 1024 && i < u.length - 1);
    return v.toFixed(1) + " " + u[i];
  }
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString("it-IT");
    } catch (_) {
      return iso;
    }
  }
  function copyText(t) {
    const fallback = () => {
      const i = document.createElement("textarea");
      i.value = t;
      document.body.appendChild(i);
      i.select();
      try {
        document.execCommand("copy");
      } catch (e) {
      }
      i.remove();
    };
    try {
      return Promise.resolve(navigator.clipboard.writeText(t)).catch(fallback);
    } catch (_) {
      fallback();
      return Promise.resolve();
    }
  }
  function fmtDuration(s) {
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    if (d > 0) return d + "g " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + x + "s";
    return x + "s";
  }
  var BIN_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz", "pdf", "zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "mp3", "wav", "ogg", "flac", "mp4", "mov", "avi", "mkv", "webm", "exe", "dll", "so", "a", "o", "bin", "dat", "class", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "woff", "woff2", "ttf", "otf", "eot", "psd", "ai", "eps"]);
  function isTextFile(name) {
    return !BIN_EXT.has((name.split(".").pop() || "").toLowerCase());
  }
  var b64ToU8 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  var SLUG_MAP = {
    "à": "a",
    "á": "a",
    "â": "a",
    "ä": "a",
    "ã": "a",
    "è": "e",
    "é": "e",
    "ê": "e",
    "ë": "e",
    "ì": "i",
    "í": "i",
    "î": "i",
    "ï": "i",
    "ò": "o",
    "ó": "o",
    "ô": "o",
    "ö": "o",
    "õ": "o",
    "ù": "u",
    "ú": "u",
    "û": "u",
    "ü": "u",
    "ç": "c",
    "ñ": "n",
    "ß": "ss"
  };
  function slugify(s) {
    return String(s).trim().toLowerCase().replace(/[\u00e0\u00e1\u00e2\u00e4\u00e3\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f2\u00f3\u00f4\u00f6\u00f5\u00f9\u00fa\u00fb\u00fc\u00e7\u00f1\u00df]/g, (c) => SLUG_MAP[c]).replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  }

  // net.js
  async function asJson(p) {
    let r;
    try {
      r = await p;
    } catch (_) {
      return { ok: false, error: "Connessione non riuscita: riprova" };
    }
    try {
      return await r.json();
    } catch (_) {
      return { ok: false, error: "Errore del server (HTTP " + r.status + "): riprova" };
    }
  }
  async function apiGet(action, params = {}) {
    const q = new URLSearchParams({ action, ...params });
    return asJson(fetch("api.php?" + q.toString()));
  }
  async function apiPost(action, data = {}) {
    const body = new FormData();
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) body.append(k, JSON.stringify(v));
      else body.append(k, v);
    }
    return asJson(fetch("api.php?action=" + action, { method: "POST", headers: { "X-CSRF": CSRF }, body }));
  }

  // zip.js
  function downloadZip(paths) {
    if (!paths.length) {
      toast("Niente da scaricare", true);
      return;
    }
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "api.php?action=zip";
    form.style.display = "none";
    for (const p of paths) {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "paths[]";
      i.value = p;
      form.appendChild(i);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }
  var _jszipLoading = null;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (_jszipLoading) return _jszipLoading;
    _jszipLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "assets/vendor/jszip.min.js?v=" + JSZIP_V;
      s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error("JSZip non disponibile"));
      s.onerror = () => reject(new Error("Impossibile caricare JSZip"));
      document.head.appendChild(s);
    });
    return _jszipLoading;
  }
  async function clientZip(manifest) {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const f of manifest.files) {
      if (!f.url) {
        zip.folder(f.name.replace(/\/$/, ""));
        continue;
      }
      const r = await fetch(f.url);
      if (!r.ok) throw new Error("HTTP " + r.status + " su " + f.name);
      zip.file(f.name, await r.blob(), { compression: "STORE" });
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const a = document.createElement("a");
    const u = URL.createObjectURL(blob);
    a.href = u;
    a.download = manifest.zipname || "download.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4e3);
  }
  async function startZip(paths) {
    if (!paths.length) {
      toast("Niente da scaricare", true);
      return;
    }
    let manifest = null;
    try {
      const fd = new FormData();
      paths.forEach((p) => fd.append("paths[]", p));
      const r = await fetch("api.php?action=zip_manifest", { method: "POST", body: fd });
      manifest = await r.json();
    } catch (_) {
      manifest = null;
    }
    if (!manifest || !manifest.ok || manifest.mode !== "client" || !Array.isArray(manifest.files)) {
      downloadZip(paths);
      return;
    }
    try {
      toast("Preparazione ZIP…");
      await clientZip(manifest);
    } catch (e) {
      downloadZip(paths);
    }
  }

  // modal.js
  function openModal(html) {
    modalBg.innerHTML = html;
    modalBg.hidden = false;
    modalBg.onclick = (e) => {
      if (e.target === modalBg) closeModal();
    };
    const first = modalBg.querySelector("input,textarea,select");
    if (first) first.focus();
  }
  function closeModal() {
    if (S.uploading) return;
    if (S.shareTimer) {
      clearInterval(S.shareTimer);
      S.shareTimer = null;
    }
    if (S.editorCleanup) {
      try {
        S.editorCleanup();
      } catch (_) {
      }
      S.editorCleanup = null;
    }
    modalBg.hidden = true;
    modalBg.innerHTML = "";
  }
  window.closeModal = closeModal;
  function guardSubmit(btn, fn) {
    let busy = false;
    return async (...a) => {
      if (busy) return;
      busy = true;
      if (btn) btn.disabled = true;
      try {
        return await fn(...a);
      } finally {
        busy = false;
        if (btn) btn.disabled = false;
      }
    };
  }
  function promptDialog(title, icon, label, placeholder, onok, okText = "Crea") {
    openModal(`<div class="modal"><h3><i class="ti ${icon}"></i> ${esc(title)}</h3>
    <label>${esc(label)}</label><input type="text" id="m_input" placeholder="${esc(placeholder)}">
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="m_ok">${esc(okText)}</button></div></div>`);
    const input = $("#m_input", modalBg);
    const go = guardSubmit($("#m_ok", modalBg), async () => {
      const val = input.value.trim();
      if (!val) return;
      const res = await onok(val);
      if (res && res.ok) {
        closeModal();
        load(S.cwd);
      } else toast(res && res.error || "Errore", true);
    });
    $("#m_ok", modalBg).onclick = go;
    input.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  }

  // editor.js
  async function openEditor(rel, name) {
    if (S.editorCleanup) closeModal();
    openModal(`<div class="modal editor-modal"><h3 style="justify-content:space-between">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><i class="ti ti-edit"></i> ${esc(name)}</span>
      <span id="ed_status" class="muted" style="font-size:12px;font-weight:400;flex:none">apertura…</span></h3>
    <div id="ed_host" class="editor-host"></div>
    <div class="modal-actions" style="justify-content:space-between;align-items:center">
      <span id="ed_pres" class="muted" style="font-size:12px"></span>
      <button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    const host = $("#ed_host", modalBg), statusEl = $("#ed_status", modalBg), presEl = $("#ed_pres", modalBg);
    const gone = () => !document.body.contains(host);
    const info = await apiGet("note_open", { path: rel });
    if (gone()) return;
    if (!info.ok) {
      statusEl.textContent = "";
      host.innerHTML = '<div style="padding:14px">' + esc(info.error || "Errore") + "</div>";
      return;
    }
    let E = null;
    try {
      E = await window.NoteEditor.loadBundle("assets/editor-bundle.js?v=" + EDITOR_BUNDLE_V);
    } catch (e) {
      E = null;
    }
    if (gone()) return;
    if (E) {
      S.editorCleanup = window.NoteEditor.mount({
        host,
        statusEl,
        presEl,
        info,
        sync: (payload) => apiPost("note_sync", Object.assign({ path: rel }, payload)),
        save: (content, snapshot) => apiPost("note_save", { path: rel, content, snapshot: snapshot || "" }),
        reopen: () => apiGet("note_open", { path: rel })
        // resync completo (epoca cambiata senza snapshot)
      });
      if (info.readonly_reason) statusEl.textContent = "sola lettura: " + info.readonly_reason;
    } else {
      editorFallback(rel, info, host, statusEl);
    }
  }
  function editorFallback(rel, info, host, statusEl) {
    statusEl.textContent = info.editable ? "editor semplice" : "sola lettura" + (info.readonly_reason ? ": " + info.readonly_reason : "");
    const text = info.text ? new TextDecoder().decode(b64ToU8(info.text)) : "";
    host.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = !info.editable;
    ta.style.cssText = "width:100%;height:100%;border:0;outline:none;resize:none;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:10px;box-sizing:border-box";
    host.appendChild(ta);
    let t = null, dirty = false;
    if (info.editable) ta.oninput = () => {
      dirty = true;
      clearTimeout(t);
      t = setTimeout(async () => {
        if (!dirty) return;
        dirty = false;
        const r = await apiPost("note_save", { path: rel, content: ta.value });
        statusEl.textContent = r.ok ? "salvato" : "errore salvataggio";
      }, 1500);
    };
    S.editorCleanup = () => {
      clearTimeout(t);
      if (dirty) {
        dirty = false;
        apiPost("note_save", { path: rel, content: ta.value });
      }
    };
  }

  // trash.js
  var fmtWhen = (ts) => new Date(ts * 1e3).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
  async function trashPanel() {
    const r = await apiGet("trash_list");
    if (!r || !r.ok) {
      toast(r && r.error || "Errore", true);
      return;
    }
    if (S.shareTimer) {
      clearInterval(S.shareTimer);
      S.shareTimer = null;
    }
    const list = Array.isArray(r.entries) ? r.entries : [];
    const days = Math.floor(Number(r.days)) || 30;
    const body = list.length ? `<div class="tr-scroll"><table class="utable tr-table"><thead><tr>
      <th>Nome</th><th>Eliminato da</th><th>Quando</th><th>Scade tra</th><th class="tr-num">Dimensione</th>${CAN_WRITE ? "<th></th>" : ""}</tr></thead><tbody>${list.map((e) => `<tr data-id="${esc(e.id)}">
      <td class="tr-name"><div><i class="ti ${iconFor({ type: e.type === "dir" ? "dir" : "file", name: String(e.name || "") })}"></i> ${esc(e.name)}</div>
        <div class="tr-orig" title="Percorso d'origine">/${esc(e.orig || "")}</div></td>
      <td data-l="Eliminato da">${esc(e.by || "—")}</td>
      <td class="tr-nw" data-l="Quando">${esc(fmtWhen(e.at))}</td>
      <td class="tr-nw" data-l="Scade tra">${e.expires_in > 0 ? esc(fmtDuration(e.expires_in)) : "a breve"}</td>
      <td class="tr-num tr-nw" data-l="Dimensione">${esc(fmtBytes(Number(e.size) || 0))}</td>
      ${CAN_WRITE ? `<td class="tr-act"><button class="btn tr-btn tr-restore"><i class="ti ti-arrow-back-up"></i> Ripristina</button>
        <button class="btn btn-danger tr-btn tr-purge">Elimina definitivamente</button></td>` : ""}</tr>`).join("")}</tbody></table></div>
  <p class="tr-note muted">Gli elementi restano qui ${days} giorni dall'eliminazione e contano nella tua quota.${CAN_WRITE ? "" : " Per ripristinarli o eliminarli serve il permesso di scrittura."}</p>` : `<p class="muted">Il cestino è vuoto. Qui finiscono per ${days} giorni gli elementi eliminati o sostituiti tramite i link.</p>`;
    openModal(`<div class="modal tr-modal"><h3><i class="ti ti-trash"></i> Cestino</h3>${body}
    <div class="modal-actions">${list.length && CAN_WRITE ? '<button class="btn btn-danger tr-empty-btn" id="tr_empty"><i class="ti ti-trash-x"></i> Svuota cestino</button>' : ""}
      <button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    let busy = false;
    const btns = () => modalBg.querySelectorAll(".tr-btn, #tr_empty");
    const stillOpen = () => !modalBg.hidden && modalBg.querySelector(".tr-modal");
    const act = (fn) => async () => {
      if (busy) return;
      busy = true;
      btns().forEach((b) => {
        b.disabled = true;
      });
      try {
        await fn();
      } finally {
        busy = false;
        btns().forEach((b) => {
          b.disabled = false;
        });
      }
    };
    const refresh = () => stillOpen() ? trashPanel() : null;
    modalBg.querySelectorAll("tr[data-id]").forEach((tr) => {
      const e = list.find((x) => String(x.id) === tr.dataset.id);
      if (!e || !CAN_WRITE) return;
      tr.querySelector(".tr-restore").onclick = act(async () => {
        const x = await apiPost("trash_restore", { id: e.id });
        if (!x.ok) {
          toast(x.error || "Errore", true);
          await refresh();
          return;
        }
        toast("Ripristinato in /" + x.path);
        load(S.cwd);
        await refresh();
      });
      tr.querySelector(".tr-purge").onclick = act(async () => {
        if (!confirm(`Eliminare definitivamente «${e.name}»? Non si potrà più recuperare.`)) return;
        const x = await apiPost("trash_purge", { id: e.id });
        if (!x.ok) {
          toast(x.error || "Errore", true);
          await refresh();
          return;
        }
        toast("Eliminato definitivamente");
        await refresh();
      });
    });
    const emptyBtn = $("#tr_empty", modalBg);
    if (emptyBtn) emptyBtn.onclick = act(async () => {
      const n = list.length;
      if (!confirm(`Svuotare il cestino? ${n === 1 ? "L'elemento sarà eliminato" : n + " elementi saranno eliminati"} definitivamente.`)) return;
      const x = await apiPost("trash_purge", { ids: JSON.stringify(list.map((v) => v.id)) });
      if (!x.ok) {
        toast(x.error || "Errore", true);
        await refresh();
        return;
      }
      toast("Cestino svuotato");
      await refresh();
    });
  }

  // accesslog.js
  var EVENTS = {
    share_view: "Visita del link",
    download: "Download",
    preview: "Anteprima",
    zip: "ZIP",
    upload: "Caricamento",
    delete: "Eliminazione",
    rename: "Rinomina",
    mkdir: "Nuova cartella",
    login: "Accesso",
    login_fail: "Accesso fallito",
    share_pin_ok: "PIN corretto",
    share_pin_fail: "PIN errato",
    share_lookup_fail: "Link inesistente"
  };
  var VIA = { presigned: "richiesta a Wasabi", server: "tramite server", direct: "diretto", sso: "SSO" };
  var when = (ts) => {
    try {
      return new Date(ts).toLocaleString("it-IT");
    } catch (_) {
      return ts;
    }
  };
  var flag = (cc) => String(cc).toUpperCase().replace(/[A-Z]/g, (c) => String.fromCodePoint(127462 + c.charCodeAt(0) - 65));
  function where(r) {
    if (r.cc === "LAN") return '<span class="muted">rete locale</span>';
    if (r.cc) return `<span title="Posizione approssimativa (IP Geolocation by DB-IP)">${flag(r.cc)} ${esc(r.city ? r.city + ", " : "")}${esc(r.country || r.cc)}</span>`;
    return '<span class="muted" title="Posizione non disponibile: database GeoIP assente o indirizzo sconosciuto">—</span>';
  }
  var who = (a) => String(a || "-").replace(/^user:/, "").replace(/^link:/, "link «").replace(/^(link «.*)$/, "$1»").replace(/^tentativo:/, "tentativo: ");
  function rowHtml(r) {
    const bad = r.status && r.status !== "ok";
    const what = (r.path ? esc(r.path) : "") + (r.to ? " → " + esc(r.to) : "") + (r.size ? ` <span class="muted">(${fmtBytes(Number(r.size) || 0)})</span>` : "");
    return `<tr>
    <td style="white-space:nowrap">${esc(when(r.ts))}</td>
    <td class="${bad ? "acc-bad" : ""}">${esc(EVENTS[r.event] || r.event)}${r.via ? ` <span class="muted">· ${esc(VIA[r.via] || r.via)}</span>` : ""}</td>
    <td class="acc-who" data-actor="${esc(r.actor || "")}">${esc(who(r.actor))}</td>
    <td>${what || '<span class="muted">—</span>'}</td>
    <td class="acc-where">${where(r)}</td>
    <td class="acc-ip" data-ip="${esc(r.ip || "")}" title="${esc(r.ua || "")}">${esc(r.ip || "")}</td></tr>`;
  }
  function accessTable(host, fixed = {}, { filters = true, initial = {}, fixedNote = "" } = {}) {
    host.innerHTML = (filters ? `<div class="acc-filters">
      <input type="date" id="af_from" title="Dal"><input type="date" id="af_to" title="Al">
      <select id="af_event"><option value="">Tutti gli eventi</option>${Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      <input type="text" id="af_actor" placeholder="Chi (utente o link)"><input type="text" id="af_path" placeholder="Percorso"><input type="text" id="af_ip" placeholder="IP"><input type="text" id="af_cc" placeholder="Paese (es. IT)" maxlength="3" size="8">
      <button class="btn" id="af_go"><i class="ti ti-search"></i> Filtra</button>
      <a class="btn" id="af_csv"><i class="ti ti-file-spreadsheet"></i> CSV</a>${fixedNote}</div>` : "") + `<div class="acc-body"><p class="muted">Caricamento…</p></div>`;
    const body = host.querySelector(".acc-body");
    const val = (id) => filters && $("#" + id, host) ? $("#" + id, host).value.trim() : "";
    const params = () => {
      const p = { ...fixed };
      [["from", "af_from"], ["to", "af_to"], ["event", "af_event"], ["actor", "af_actor"], ["path", "af_path"], ["ip", "af_ip"], ["cc", "af_cc"]].forEach(([k, id]) => {
        const v = val(id);
        if (v) p[k] = v;
      });
      return p;
    };
    let rows = [];
    const load2 = async (cursor = "") => {
      const r = await apiGet("access_list", { ...params(), limit: 200, ...cursor ? { cursor } : {} });
      if (!r.ok) {
        body.innerHTML = `<p class="acc-bad">${esc(r.error || "Errore")}</p>`;
        return;
      }
      rows = cursor ? rows.concat(r.rows) : r.rows;
      body.innerHTML = rows.length ? `<table class="utable acc-table"><thead><tr><th>Quando</th><th>Evento</th><th>Chi</th><th>File</th><th>Da dove</th><th>IP</th></tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table>` + (r.next ? '<div style="text-align:center;margin-top:8px"><button class="btn" id="af_more">Mostra altri</button></div>' : "") : '<p class="muted">Nessun accesso registrato con questi filtri.</p>';
      if (r.next) $("#af_more", body).onclick = () => load2(r.next);
      if (filters) {
        body.querySelectorAll("[data-ip]").forEach((td) => td.onclick = () => {
          $("#af_ip", host).value = td.dataset.ip;
          load2();
        });
        body.querySelectorAll("[data-actor]").forEach((td) => td.onclick = () => {
          $("#af_actor", host).value = td.dataset.actor.replace(/^(user|link):/, "");
          load2();
        });
      }
    };
    if (filters) {
      if (initial.path) $("#af_path", host).value = initial.path;
      $("#af_go", host).onclick = () => load2();
      host.querySelectorAll(".acc-filters input").forEach((i) => {
        i.onkeydown = (e) => {
          if (e.key === "Enter") load2();
        };
      });
      $("#af_csv", host).onclick = () => {
        location.href = "api.php?" + new URLSearchParams({ action: "access_export", ...params() });
      };
    }
    load2();
  }
  async function shareAccessPanel(s, back) {
    const r = await apiGet("access_list", { token: String(s.token).slice(0, 8), limit: 500 });
    const rows = r.ok ? r.rows : [];
    const n = (ev) => rows.filter((x) => x.event === ev).length;
    const ips = new Set(rows.map((x) => x.ip)).size;
    const countries = [...new Set(rows.filter((x) => x.cc && x.cc !== "LAN").map((x) => x.cc))];
    openModal(`<div class="modal wide"><h3><i class="ti ti-activity"></i> Accessi al link${s.label ? " di «" + esc(s.label) + "»" : ""}</h3>
    <p class="muted" style="margin-top:-6px">${esc(s.name)} · ultimi ${rows.length} eventi</p>
    ${r.ok ? `<div class="acc-sum"><span><b>${n("share_view")}</b>visite</span><span><b>${n("download") + n("zip")}</b>download</span><span><b>${n("preview")}</b>anteprime</span><span><b>${n("upload")}</b>caricamenti</span><span><b>${ips}</b>IP distinti</span><span><b>${countries.length ? countries.map(flag).join(" ") : "—"}</b>${countries.length === 1 ? "paese" : "paesi"}</span><span><b>${rows[0] ? esc(when(rows[0].ts)) : "—"}</b>ultimo accesso</span></div>` : ""}
    <div id="acc_host" class="sh-scroll"></div>
    <p class="muted" style="font-size:11px">Ogni clic su un file è registrato con data, ora e indirizzo IP.</p>
    <div class="modal-actions"><button class="btn" id="acc_back"><i class="ti ti-arrow-left"></i> Condivisioni</button><a class="btn" href="index.php?view=registro&token=${esc(String(s.token).slice(0, 8))}"><i class="ti ti-activity"></i> Apri nel registro</a><button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    const host = $("#acc_host", modalBg);
    if (!r.ok) host.innerHTML = `<p class="acc-bad">${esc(r.error || "Errore")}</p>`;
    else host.innerHTML = rows.length ? `<table class="utable acc-table"><thead><tr><th>Quando</th><th>Evento</th><th>Chi</th><th>File</th><th>Da dove</th><th>IP</th></tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table>` : '<p class="muted">Nessun accesso registrato per questo link.</p>';
    $("#acc_back", modalBg).onclick = back;
  }
  function registroPage(host) {
    if (!host) return;
    const q = new URLSearchParams(location.search);
    const fixed = {};
    const token = (q.get("token") || "").replace(/[^0-9a-f]/gi, "").slice(0, 8);
    if (token) fixed.token = token;
    const initial = { path: (q.get("path") || "").replace(/^\/+/, "") };
    const fixedNote = token ? `<span class="acc-fixed"><i class="ti ti-link"></i> solo il link ${esc(token)}… <a href="index.php?view=registro">tutti gli eventi</a></span>` : "";
    let scope = "all";
    const seg = document.getElementById("accScope");
    const render = () => accessTable(host, { ...fixed, ...scope === "mine" ? { owner: USER } : {} }, { initial, fixedNote });
    if (seg) seg.querySelectorAll("button").forEach((b) => b.onclick = () => {
      scope = b.dataset.scope;
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      render();
    });
    render();
    const note = document.createElement("p");
    note.className = "acc-note";
    note.innerHTML = 'Ogni evento riporta data e ora, chi ha agito (utente o link), file, esito e indirizzo IP della connessione. Conservazione: 12 mesi. La posizione è approssimativa, a livello di città o di provider · IP Geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a>.';
    host.after(note);
  }

  // shares.js
  var DIR_LEVELS = [
    ["view", "Sola lettura", "Vede e scarica i file. Non può modificare nulla."],
    ["edit", "Caricamento", "Può anche caricare file. Non sovrascrive niente: un nome già presente diventa «nome (2)»."],
    ["contrib", "Collaboratore", "Carica file e crea cartelle. Sostituisce, rinomina ed elimina solo ciò che ha caricato con questo link; ciò che elimina o sostituisce finisce nel tuo cestino."],
    ["manage", "Gestione completa", "Carica, sovrascrive, rinomina ed elimina tutto nella cartella. Ciò che elimina o sostituisce finisce nel tuo cestino. Meglio con un PIN."]
  ];
  var NOTE_LEVELS = [
    ["view", "Sola lettura", "Legge e scarica la nota."],
    ["edit", "Modificabile (co-editing)", "Modifica la nota insieme a te, in tempo reale."]
  ];
  var UPLOAD_LEVELS = /* @__PURE__ */ new Set(["edit", "contrib", "manage"]);
  function levelName(mode, isDir) {
    const l = (isDir ? DIR_LEVELS : NOTE_LEVELS).find((x) => x[0] === mode);
    return l ? l[1].replace(/ \(co-editing\)$/, "") : "Sola lettura";
  }
  var READABLE_MAX = 42;
  var readablePart = (v) => slugify(v).slice(0, READABLE_MAX).replace(/-+$/, "") || "link";
  function slugStamp(d = /* @__PURE__ */ new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    try {
      const p = {};
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Rome",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(d).forEach((x) => {
        p[x.type] = x.value;
      });
      if (p.year && p.minute) return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
    } catch (_) {
    }
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  var LIMIT_OPTS = `<option value="100">100 MB</option>
      <option value="500">500 MB</option>
      <option value="1024" selected>1 GB</option>
      <option value="5120">5 GB</option>
      <option value="0">Nessun tetto (solo la mia quota)</option>`;
  function shareDialog(rel, name, isDir = false) {
    const levels = !CAN_WRITE ? null : isDir ? DIR_LEVELS : isTextFile(name) ? NOTE_LEVELS : null;
    const defName = isDir ? name : name.replace(/\.[^.]+$/, "");
    const defSlug = slugify(defName);
    const base = location.origin + location.pathname.replace(/\/[^/]*$/, "");
    const access = levels ? `<label for="sh_mode">Accesso</label>
    <select id="sh_mode">${levels.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join("")}</select>
    <div id="sh_mode_help" class="sh-help"></div>
    ${isDir ? `<div id="sh_limit_wrap" hidden><label for="sh_limit">Spazio caricabile tramite il link <span class="sh-opt">(oltre vale la tua quota)</span></label>
    <select id="sh_limit">${LIMIT_OPTS}</select></div>` : ""}` : `<label>Accesso</label><div class="sh-fixed"><i class="ti ti-eye"></i> Sola lettura
      <span class="muted">— ${isDir ? "vede e scarica i file" : "può scaricare il file"}</span></div>`;
    openModal(`<div class="modal sh-modal"><h3><i class="ti ti-share"></i> Condividi "${esc(name)}"</h3>
    <label for="sh_label">A chi lo dai <span class="sh-opt">(facoltativo)</span></label>
    <input type="text" id="sh_label" maxlength="80" placeholder="es. Avv. Bianchi" autocomplete="off">
    <label for="sh_ttl">Durata del link</label>
    <select id="sh_ttl">
      <option value="3600">1 ora</option>
      <option value="86400" selected>24 ore</option>
      <option value="604800">7 giorni</option>
      <option value="2592000">30 giorni</option>
    </select>
    ${access}
    <label for="sh_pin">PIN <span class="sh-opt">(facoltativo, da 4 a 64 caratteri)</span></label>
    <input type="text" id="sh_pin" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="sh-help">Comunicalo a parte (telefono, messaggio). Senza PIN basta il link.</div>
    <label for="sh_slug">Indirizzo del link</label>
    <div class="sh-slug"><span class="muted">/d/</span>
      <input type="text" id="sh_slug" value="${esc(defSlug)}" placeholder="${esc(readablePart(defName))}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div id="sh_slughint" class="sh-preview"></div>
    <div class="sh-help">Data, ora e codice casuale vengono aggiunti automaticamente: ogni link è unico e non si indovina.</div>
    <div id="sh_err" class="sh-err" hidden></div>
    <div id="sh_result"></div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button>
      <button class="btn btn-primary" id="sh_create"><i class="ti ti-link"></i> Crea link</button></div></div>`);
    const slugEl = $("#sh_slug", modalBg), hintEl = $("#sh_slughint", modalBg), errEl = $("#sh_err", modalBg);
    const modeEl = $("#sh_mode", modalBg);
    const showErr = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    };
    const updHint = () => {
      const r = readablePart(slugEl.value.trim() === "" ? defName : slugEl.value);
      hintEl.textContent = "→ " + base + "/d/" + r + "-" + slugStamp() + "-xxxxxx";
    };
    slugEl.oninput = updHint;
    updHint();
    const curMode = () => modeEl ? modeEl.value : "view";
    const hasCap = () => isDir && UPLOAD_LEVELS.has(curMode());
    if (modeEl) {
      const helpEl = $("#sh_mode_help", modalBg), limWrap = $("#sh_limit_wrap", modalBg);
      modeEl.onchange = () => {
        helpEl.textContent = (levels.find((l) => l[0] === modeEl.value) || levels[0])[2];
        if (limWrap) limWrap.hidden = !hasCap();
      };
      modeEl.onchange();
    }
    $("#sh_create", modalBg).onclick = guardSubmit($("#sh_create", modalBg), async () => {
      showErr("");
      const mode = curMode();
      const label = $("#sh_label", modalBg).value.trim();
      const pinEl = $("#sh_pin", modalBg);
      const pin = pinEl.value.trim();
      pinEl.value = pin;
      if (pin && [...pin].length < 4) {
        showErr("Il PIN deve avere almeno 4 caratteri (oppure lascialo vuoto).");
        pinEl.focus();
        return;
      }
      const limitMb = hasCap() ? $("#sh_limit", modalBg).value : "";
      const r = await apiPost("share_create", {
        path: rel,
        ttl: $("#sh_ttl", modalBg).value,
        mode,
        slug: slugEl.value.trim(),
        label,
        pin,
        upload_limit_mb: limitMb
      });
      if (!r || !r.ok) {
        showErr(r && r.error || "Errore nella creazione del link");
        return;
      }
      const rMode = r.mode || mode, rLabel = r.label != null ? r.label : label;
      const when2 = new Date(r.expires_at * 1e3).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
      const cap = hasCap() ? Number(limitMb) > 0 ? ` · fino a ${fmtBytes(Number(limitMb) * 1048576)}` : " · nessun tetto" : "";
      $("#sh_result", modalBg).innerHTML = `<div class="sh-done">
      <label for="sh_url">Link creato</label>
      <div class="sh-url"><input type="text" id="sh_url" readonly value="${esc(r.url)}">
        <button class="btn" id="sh_copy" title="Copia link"><i class="ti ti-copy"></i></button></div>
      <dl class="sh-sum">
        <dt>Livello</dt><dd>${esc(levelName(rMode, isDir) + cap)}</dd>
        ${rLabel ? `<dt>Destinatario</dt><dd>${esc(rLabel)}</dd>` : ""}
        <dt>Scade</dt><dd>${esc(when2)}</dd>
      </dl>
      ${r.has_pin ? '<div class="sh-pinset"><i class="ti ti-lock"></i> PIN impostato: comunicalo separatamente</div>' : ""}</div>`;
      modalBg.querySelectorAll("#sh_label, #sh_ttl, #sh_mode, #sh_limit, #sh_pin, #sh_slug").forEach((el) => {
        el.disabled = true;
      });
      $("#sh_create", modalBg).remove();
      modalBg.querySelector(".modal-actions .btn").classList.add("btn-primary");
      const inp = $("#sh_url", modalBg);
      inp.focus();
      inp.select();
      $("#sh_copy", modalBg).onclick = () => {
        copyText(r.url);
        toast("Link copiato");
      };
    });
  }
  function shareMeta(s, isAdmin) {
    const isDir = s.type === "dir";
    const mode = s.mode || "view", level = s.level || mode;
    const parts = [];
    if (s.label) parts.push(`per «${esc(s.label)}»`);
    parts.push(level === mode ? esc(levelName(level, isDir)) : `${esc(levelName(level, isDir))} <span title="Chi l'ha creato non ha più il permesso di scrittura">(era ${esc(levelName(mode, isDir))})</span>`);
    if (s.has_pin) parts.push('<i class="ti ti-lock" title="Protetto da PIN" aria-label="Protetto da PIN"></i>');
    if (s.missing) parts.push(`<span class="acc-bad" title="Il file o la cartella non esiste più nello storage (eliminato fuori dall'app, o archiviazione cambiata senza spostare i file): il link risponde «non valido»">elemento non trovato</span>`);
    if (isDir && UPLOAD_LEVELS.has(mode)) {
      const used = Number(s.uploaded) || 0, cap = Number(s.upload_limit) || 0;
      parts.push(esc("caricati " + fmtBytes(used) + (cap > 0 ? " / " + fmtBytes(cap) : " (nessun tetto)")));
    }
    if (isAdmin && s.created_by) parts.push("di " + esc(s.created_by));
    return parts.join(" · ");
  }
  async function sharesPanel() {
    const [r, t] = await Promise.all([apiGet("share_list"), apiGet("trash_list").catch(() => null)]);
    if (!r.ok) {
      toast(r.error || "Errore", true);
      return;
    }
    const nTrash = t && t.ok && Array.isArray(t.entries) ? t.entries.length : null;
    const body = r.shares.length ? `<div class="sh-scroll"><table class="utable sh-table"><thead><tr><th>Elemento</th><th>Scade</th><th></th></tr></thead><tbody>${r.shares.map((s) => `<tr data-exp="${Number(s.expires_at) || 0}">
      <td><div class="sh-name"><i class="ti ${iconFor({ type: s.type === "dir" ? "dir" : "file", name: String(s.name || "") })}"></i> ${esc(s.name)}</div>
        <div class="sh-meta">${shareMeta(s, r.is_admin)}</div></td>
      <td class="sh-rem" style="white-space:nowrap"></td>
      <td class="uact" style="white-space:nowrap">
        <i class="ti ti-activity" data-acc="${esc(s.token)}" title="Accessi"></i>
        <i class="ti ti-key" data-pin="${esc(s.token)}" title="${s.has_pin ? "Cambia o togli il PIN" : "Imposta un PIN"}"></i>
        <i class="ti ti-clock-edit" data-ttl="${esc(s.token)}" title="Cambia scadenza"></i>
        <i class="ti ti-copy" data-url="${esc(s.url)}" title="Copia link"></i>
        <i class="ti ti-trash" data-revoke="${esc(s.token)}" title="Revoca"></i></td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">Nessuna condivisione attiva.</p>';
    openModal(`<div class="modal wide sh-panel"><h3><i class="ti ti-share"></i> Condivisioni attive</h3>${body}
    <div class="modal-actions"><button class="btn sh-trash-btn" id="sh_trash"><i class="ti ti-trash"></i> Cestino${nTrash !== null ? ` (${nTrash})` : ""}</button>
      <button class="btn" onclick="closeModal()">Chiudi</button></div></div>`);
    $("#sh_trash", modalBg).onclick = () => trashPanel();
    modalBg.querySelectorAll("[data-url]").forEach((b) => b.onclick = () => {
      copyText(b.dataset.url);
      toast("Link copiato");
    });
    modalBg.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => {
      const s = r.shares.find((x2) => x2.token === b.dataset.revoke) || {};
      const who2 = s.label ? ` di «${s.label}»` : "";
      if (!confirm(`Revocare il link${who2} a «${s.name || ""}»? Smetterà subito di funzionare.`)) return;
      const x = await apiPost("share_revoke", { token: b.dataset.revoke });
      if (x.ok) {
        toast("Condivisione revocata");
        sharesPanel();
      } else toast(x.error || "Errore", true);
    });
    modalBg.querySelectorAll("[data-acc]").forEach((b) => b.onclick = () => {
      const s = r.shares.find((x) => x.token === b.dataset.acc);
      if (s) {
        if (S.shareTimer) {
          clearInterval(S.shareTimer);
          S.shareTimer = null;
        }
        shareAccessPanel(s, sharesPanel);
      }
    });
    modalBg.querySelectorAll("[data-pin]").forEach((b) => b.onclick = () => {
      const s = r.shares.find((x) => x.token === b.dataset.pin);
      const td = b.closest("tr").querySelector("td");
      if (!s || td.querySelector(".sh-pin-edit")) return;
      const box = document.createElement("div");
      box.className = "sh-pin-edit";
      box.innerHTML = `<input type="text" autocomplete="off" placeholder="${s.has_pin ? "Nuovo PIN" : "PIN (4–64 caratteri)"}" maxlength="64">
      <button class="btn btn-primary" data-act="set">${s.has_pin ? "Cambia PIN" : "Imposta PIN"}</button>
      ${s.has_pin ? '<button class="btn" data-act="remove">Togli PIN</button>' : ""}<button class="btn" data-act="cancel">Annulla</button>
      <span class="muted sh-pin-note">Comunicalo a parte. Chi aveva già inserito il vecchio PIN dovrà inserire quello nuovo.</span>`;
      td.appendChild(box);
      const inp = box.querySelector("input");
      inp.focus();
      const send = async (data, msg) => {
        box.querySelectorAll("button").forEach((x2) => {
          x2.disabled = true;
        });
        const x = await apiPost("share_update", { token: s.token, ...data });
        if (x.ok) {
          toast(msg);
          sharesPanel();
        } else {
          toast(x.error || "Errore", true);
          box.querySelectorAll("button").forEach((y) => {
            y.disabled = false;
          });
        }
      };
      box.querySelector('[data-act="set"]').onclick = () => {
        const v = inp.value;
        if (v.length < 4) {
          toast("Il PIN deve avere almeno 4 caratteri", true);
          inp.focus();
          return;
        }
        send({ pin_action: "set", pin: v }, s.has_pin ? "PIN cambiato" : "PIN impostato");
      };
      inp.onkeydown = (e) => {
        if (e.key === "Enter") box.querySelector('[data-act="set"]').onclick();
      };
      const rm = box.querySelector('[data-act="remove"]');
      if (rm) rm.onclick = () => {
        if (confirm("Togliere il PIN? Basterà l'indirizzo per aprire il link.")) send({ pin_action: "remove" }, "PIN tolto");
      };
      box.querySelector('[data-act="cancel"]').onclick = () => box.remove();
    });
    modalBg.querySelectorAll("[data-ttl]").forEach((b) => b.onclick = () => {
      const tr = b.closest("tr");
      const cell = tr.querySelector(".sh-rem");
      if (tr.dataset.editing) return;
      tr.dataset.editing = "1";
      cell.innerHTML = `<select class="sh-ttl"><option value="">Scade da adesso tra…</option><option value="3600">1 ora</option><option value="86400">24 ore</option><option value="604800">7 giorni</option><option value="2592000">30 giorni</option></select>`;
      const sel = cell.querySelector("select");
      sel.focus();
      sel.onchange = async () => {
        if (!sel.value) return;
        sel.disabled = true;
        const x = await apiPost("share_update", { token: b.dataset.ttl, ttl: sel.value });
        if (x.ok) {
          toast("Scadenza aggiornata");
          sharesPanel();
        } else {
          toast(x.error || "Errore", true);
          delete tr.dataset.editing;
          sel.disabled = false;
        }
      };
    });
    if (S.shareTimer) clearInterval(S.shareTimer);
    const skew = (typeof r.now === "number" ? r.now : Date.now() / 1e3) - Date.now() / 1e3;
    const tick = () => {
      modalBg.querySelectorAll("tr[data-exp]").forEach((tr) => {
        const rem = tr.dataset.exp - (Date.now() / 1e3 + skew);
        const cell = tr.querySelector(".sh-rem");
        if (rem <= 0) tr.remove();
        else if (cell && !tr.dataset.editing) cell.textContent = "tra " + fmtDuration(rem);
      });
    };
    tick();
    S.shareTimer = setInterval(tick, 1e3);
  }

  // dialogs.js
  function newFolderDialog() {
    promptDialog(
      "Nuova cartella",
      "ti-folder-plus",
      "Nome cartella",
      "es. documenti",
      (name) => apiPost("mkdir", { path: S.cwd, name })
    );
  }
  function newFileDialog() {
    openModal(`<div class="modal"><h3><i class="ti ti-file-plus"></i> Nuovo file</h3>
    <label>Nome file</label><input type="text" id="f_name" placeholder="es. note.txt">
    <label>Contenuto (opzionale)</label><textarea id="f_body"></textarea>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="f_ok">Crea</button></div></div>`);
    $("#f_ok", modalBg).onclick = guardSubmit($("#f_ok", modalBg), async () => {
      const name = $("#f_name", modalBg).value.trim();
      if (!name) return;
      const res = await apiPost("newfile", { path: S.cwd, name, content: $("#f_body", modalBg).value });
      if (res.ok) {
        closeModal();
        load(S.cwd);
      } else toast(res.error || "Errore", true);
    });
  }
  function renameDialog(oldName, rel) {
    promptDialog(
      "Rinomina",
      "ti-pencil",
      "Nuovo nome",
      oldName,
      (name) => apiPost("rename", { from: rel, to: name }),
      "Rinomina"
    );
    const input = $("#m_input", modalBg);
    input.value = oldName;
    input.select();
  }
  function deleteDialog(paths, label) {
    const what = paths.length === 1 ? `"${esc(label || paths[0])}"` : `${paths.length} elementi`;
    openModal(`<div class="modal"><div class="center"><div class="warn-ico"><i class="ti ti-alert-triangle"></i></div>
    <h3 style="justify-content:center">Eliminare ${what}?</h3>
    <p class="muted">L'operazione è definitiva e non reversibile.</p></div>
    <div class="modal-actions" style="justify-content:center">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-danger" id="d_ok"><i class="ti ti-trash"></i> Elimina</button></div></div>`);
    $("#d_ok", modalBg).onclick = guardSubmit($("#d_ok", modalBg), async () => {
      const res = await apiPost("delete", { paths });
      if (res.ok) {
        closeModal();
        load(S.cwd);
        if (res.errors && res.errors.length) toast(`Eliminati: ${res.deleted} · non eliminati: ${res.errors.length} (${res.errors[0]})`, true);
        else toast(`Eliminati: ${res.deleted}`);
      } else toast(res.error || "Errore", true);
    });
  }
  function newNoteDialog() {
    openModal(`<div class="modal"><h3><i class="ti ti-note"></i> Nuova nota</h3>
    <label>Nome nota</label><input type="text" id="nn_name" placeholder="es. appunti.md">
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="nn_ok"><i class="ti ti-edit"></i> Crea e apri</button></div></div>`);
    const go = guardSubmit($("#nn_ok", modalBg), async () => {
      let name = $("#nn_name", modalBg).value.trim();
      if (!name) return;
      if (!/\.[a-z0-9]+$/i.test(name)) name += ".md";
      const r = await apiPost("newfile", { path: S.cwd, name, content: "" });
      const rel = (S.cwd ? S.cwd + "/" : "") + name;
      if (r.ok || /esiste già/i.test(r.error || "")) {
        closeModal();
        load(S.cwd);
        openEditor(rel, name);
      } else toast(r.error || "Errore", true);
    });
    $("#nn_ok", modalBg).onclick = go;
    $("#nn_name", modalBg).onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  }

  // listing.js
  var loadSeq = 0;
  async function load(path = "") {
    const my = ++loadSeq;
    const res = await apiGet("list", { path });
    if (my !== loadSeq) return;
    if (!res.ok) {
      toast(res.error || "Errore", true);
      return;
    }
    S.cwd = res.path === "/" ? "" : res.path.replace(/^\//, "");
    S.items = res.items;
    selected.clear();
    renderCrumbs();
    renderRows();
    updateSelbar();
  }
  function renderCrumbs() {
    const parts = S.cwd ? S.cwd.split("/") : [];
    let acc = "";
    let html = `<a data-path=""><i class="ti ti-home"></i> radice</a>`;
    parts.forEach((p, i) => {
      acc += (acc ? "/" : "") + p;
      html += `<span class="sep"><i class="ti ti-chevron-right"></i></span>`;
      html += i === parts.length - 1 ? `<span class="cur">${esc(p)}</span>` : `<a data-path="${esc(acc)}">${esc(p)}</a>`;
    });
    crumbsEl.innerHTML = html;
    crumbsEl.querySelectorAll("a").forEach((a) => a.onclick = () => load(a.dataset.path));
  }
  function renderRows() {
    const filter = searchEl.value.trim().toLowerCase();
    const shown = S.items.filter((it) => !filter || it.name.toLowerCase().includes(filter));
    rowsEl.innerHTML = "";
    emptyEl.hidden = shown.length > 0;
    for (const it of shown) {
      const rel = (S.cwd ? S.cwd + "/" : "") + it.name;
      const row = document.createElement("div");
      row.className = "row" + (selected.has(rel) ? " sel" : "");
      const isDir = it.type === "dir";
      const isText = !isDir && isTextFile(it.name);
      const pk = !isDir && window.Preview ? window.Preview.kindOf(it.name) : null;
      const canPreview = pk && pk !== "txt";
      const shared = !!it.shared;
      row.innerHTML = `
      <label class="cb"><input type="checkbox" ${selected.has(rel) ? "checked" : ""}></label>
      <div class="name ${isDir || isText || canPreview ? "clickable" : ""}">
        <i class="ti ${iconFor(it)}"></i><span class="label" title="${esc(it.name)}">${esc(it.name)}</span>${shared ? '<span class="badge badge-link" title="Condivisa con un link attivo"><i class="ti ti-link"></i><span class="badge-txt">condivisa</span></span>' : ""}
      </div>
      <div class="size">${isDir ? "—" : esc(it.size_h)}</div>
      <div class="date">${esc(it.mtime)}</div>
      <div class="acts">
        ${shared ? '<i class="ti ti-activity ti-acc" title="Accessi a questo elemento"></i>' : ""}
        ${isText ? '<i class="ti ti-edit" title="Modifica nota"></i>' : ""}
        <i class="ti ti-share" title="Condividi"></i>
        <i class="ti ti-download" title="Scarica"></i>
        ${CAN_WRITE ? '<i class="ti ti-pencil" title="Rinomina"></i><i class="ti ti-trash" title="Elimina"></i>' : ""}
      </div>`;
      row.querySelector("input").onchange = (e) => {
        e.target.checked ? selected.add(rel) : selected.delete(rel);
        row.classList.toggle("sel", e.target.checked);
        updateSelbar();
      };
      if (isDir) row.querySelector(".label").onclick = () => load(rel);
      else if (canPreview) row.querySelector(".label").onclick = () => window.Preview.open({
        url: "api.php?action=download&path=" + encodeURIComponent(rel),
        name: it.name,
        size: it.size,
        onEdit: isText && CAN_WRITE ? () => openEditor(rel, it.name) : null
      });
      else if (isText) row.querySelector(".label").onclick = () => openEditor(rel, it.name);
      if (isText) row.querySelector(".ti-edit").onclick = () => openEditor(rel, it.name);
      row.querySelector(".ti-download").onclick = () => {
        if (isDir) startZip([rel]);
        else window.location = "api.php?action=download&path=" + encodeURIComponent(rel);
      };
      row.querySelector(".ti-share").onclick = () => shareDialog(rel, it.name, isDir);
      if (shared) row.querySelector(".ti-acc").onclick = () => {
        location.href = "index.php?view=registro&path=" + encodeURIComponent(rel);
      };
      if (CAN_WRITE) {
        row.querySelector(".ti-pencil").onclick = () => renameDialog(it.name, rel);
        row.querySelector(".ti-trash").onclick = () => deleteDialog([rel], it.name);
      }
      rowsEl.appendChild(row);
    }
    $("#checkAll").checked = shown.length > 0 && shown.every((it) => selected.has((S.cwd ? S.cwd + "/" : "") + it.name));
  }
  function updateSelbar() {
    selbar.hidden = selected.size === 0;
    selCount.textContent = selected.size + (selected.size === 1 ? " elemento selezionato" : " elementi selezionati");
  }

  // admin.js
  async function adminPanel(section) {
    section = section || "users";
    const tab = (k, ic, lbl) => `<button class="btn ${section === k ? "btn-primary" : ""}" data-sec="${k}"><i class="ti ${ic}"></i> ${lbl}</button>`;
    openModal(`<div class="modal wide admin-modal"><h3><i class="ti ti-settings"></i> Amministrazione${APP_VERSION ? ` <span class="muted" style="font-size:12px;font-weight:400">v${esc(APP_VERSION)}</span>` : ""}</h3>
    <div class="adm-tabs">
      ${tab("users", "ti-users-group", "Utenti")}${tab("settings", "ti-adjustments", "Impostazioni")}${tab("audit", "ti-history", "Registro")}
    </div>
    <div id="adm_body">Caricamento…</div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="adm_save" hidden><i class="ti ti-device-floppy"></i> Salva</button>
      <button class="btn" onclick="closeModal()">Chiudi</button>
    </div></div>`);
    modalBg.querySelectorAll("[data-sec]").forEach((b) => b.onclick = () => adminPanel(b.dataset.sec));
    const saveBtn = $("#adm_save", modalBg);
    if (saveBtn) saveBtn.hidden = section !== "settings";
    const body = $("#adm_body", modalBg);
    if (section === "settings") await renderSettingsSection(body);
    else if (section === "audit") await renderAuditSection(body);
    else await renderUsersSection(body);
  }
  async function renderUsersSection(body, usageRefresh) {
    const useParams = usageRefresh ? { refresh: usageRefresh } : {};
    const [res, use] = await Promise.all([apiGet("users_list"), apiGet("usage_list", useParams)]);
    if (!res.ok) {
      body.textContent = res.error || "Errore";
      return;
    }
    const usage = {};
    if (use && use.ok) use.users.forEach((u) => usage[u.username] = u);
    const spaceCell = (name) => {
      const u = usage[name];
      if (!u) return '<span class="muted">—</span>';
      if (!u.quota) return `${esc(u.usage_h)} <span class="muted">/ illimitata</span>${u.stale ? ' <span class="muted" title="valore in cache">~</span>' : ""}`;
      const pct = u.pct == null ? 0 : u.pct;
      const cls = pct >= 100 ? "q-red" : pct >= 80 ? "q-amber" : "q-green";
      return `<div class="quota-bar"><div class="${cls}" style="width:${Math.min(100, pct)}%"></div></div><span class="quota-txt">${esc(u.usage_h)} / ${esc(u.quota_h)} (${pct}%)${u.stale ? " ~" : ""}</span>`;
    };
    const rows = res.users.map((u) => `
    <tr><td><i class="ti ti-user"></i> ${esc(u.username)}</td>
      <td>${u.role === "admin" ? "<b>admin</b>" : "utente"}</td>
      <td>${u.permission === "write" ? "lettura e scrittura" : "sola lettura"}</td>
      <td class="uspace">${spaceCell(u.username)}</td>
      <td class="uact">
        <i class="ti ti-refresh" title="Aggiorna spazio" data-refresh="${esc(u.username)}"></i>
        <i class="ti ti-edit" data-u="${esc(u.username)}" data-r="${u.role}" data-p="${u.permission}" data-q="${u.quota_mb || 0}"></i>
        <i class="ti ti-trash" data-del="${esc(u.username)}"></i></td></tr>`).join("");
    body.innerHTML = `<div style="text-align:right;margin-bottom:8px"><button class="btn btn-primary" id="u_new"><i class="ti ti-user-plus"></i> Nuovo utente</button></div>
    <table class="utable"><thead><tr><th>Utente</th><th>Ruolo</th><th>Permessi</th><th>Spazio</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    $("#u_new", modalBg).onclick = () => userForm();
    modalBg.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      const name = b.dataset.del;
      if (!confirm(`Eliminare l'utente "${name}"?
Le sue condivisioni pubbliche verranno revocate.`)) return;
      const purge = confirm(`Eliminare anche TUTTI i file di "${name}" dallo storage?

OK = elimina anche i file (irreversibile)
Annulla = conserva i file`);
      const r = await apiPost("user_delete", { username: name, purge: purge ? "1" : "0" });
      if (r.ok) {
        toast("Utente eliminato");
        adminPanel("users");
      } else toast(r.error || "Errore", true);
    });
    modalBg.querySelectorAll("[data-refresh]").forEach((b) => b.onclick = () => renderUsersSection(body, b.dataset.refresh));
    modalBg.querySelectorAll("[data-u]").forEach((b) => b.onclick = () => userForm({ username: b.dataset.u, role: b.dataset.r, permission: b.dataset.p, quota_mb: parseInt(b.dataset.q || "0", 10) }));
  }
  function oidcSection(o) {
    const on = !!o.enabled;
    const envNote = o.from_env ? ' <span class="muted" style="font-size:11px">(secret presente anche da ambiente)</span>' : "";
    const fld = (id, label, val, ph = "", type = "text") => `<div class="fld"><label>${label}</label><input type="${type}" id="${id}" value="${type === "password" ? "" : esc(val || "")}" placeholder="${esc(ph)}" autocomplete="${type === "password" ? "new-password" : "off"}"></div>`;
    return `
    <h3 style="margin:18px 0 4px;font-size:15px;display:flex;align-items:center;gap:6px"><i class="ti ti-shield-lock"></i> SSO / OpenID Connect</h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px">Accesso "Accedi con desoauth" via OAuth2/OIDC. I valori qui hanno la precedenza su quelli in <code>.htaccess</code>/ambiente.</p>
    <label class="sw"><input type="checkbox" id="oidc_enabled" ${on ? "checked" : ""}> Abilita SSO${envNote}</label>
    <div id="oidc_box" style="margin-top:8px${on ? "" : ";display:none"}">
      <label style="margin-top:8px">Issuer</label>
      <div style="display:flex;gap:6px">
        <input type="text" id="oidc_issuer" value="${esc(o.issuer || "")}" placeholder="https://auth.deso.tech/application/o/desoshare/" autocomplete="off" style="flex:1">
        <button class="btn" id="oidc_disco" type="button" title="Compila gli endpoint dall'issuer"><i class="ti ti-download"></i> Discovery</button>
      </div>
      <span id="oidc_discomsg" class="muted" style="font-size:12px"></span>
      <div class="grid2" style="margin-top:8px">
        ${fld("oidc_client_id", "Client ID", o.client_id, "Pubj2…")}
        <div class="fld"><label>Client Secret</label>
          <input type="password" id="oidc_secret" value="" autocomplete="new-password" placeholder="${o.has_secret ? "•••••••• (invariato)" : "inserisci il secret"}">
          <span class="muted" style="font-size:11px">Vuoto = non modificare (cifrato sul server)</span></div>
        ${fld("oidc_admin_group", "Gruppo admin", o.admin_group, "desoshare_admin")}
        ${fld("oidc_rw_group", "Gruppo lettura-scrittura", o.rw_group, "desoshare_user")}
      </div>
      <label style="margin-top:8px">Scopes</label>
      <input type="text" id="oidc_scopes" value="${esc(o.scopes || "")}" placeholder="openid email profile" autocomplete="off">
      <details class="adv">
        <summary>Endpoint avanzati (di solito compilati dal Discovery)</summary>
        <div class="grid2" style="margin-top:8px">
          ${fld("oidc_authz", "Authorization endpoint", o.authz)}
          ${fld("oidc_token", "Token endpoint", o.token)}
          ${fld("oidc_userinfo", "Userinfo endpoint", o.userinfo)}
          ${fld("oidc_jwks", "JWKS URI", o.jwks)}
          ${fld("oidc_endsession", "End-session endpoint", o.endsession)}
          ${fld("oidc_redirect", "Redirect URI", o.redirect)}
        </div>
      </details>
      <div style="margin-top:10px"><button class="btn" id="oidc_testbtn" type="button"><i class="ti ti-plug-connected"></i> Prova SSO</button> <span id="oidc_testmsg" class="muted" style="font-size:12px"></span></div>
    </div>`;
  }
  async function renderSettingsSection(body) {
    const s = await apiGet("settings_get");
    if (!s.ok) {
      body.textContent = s.error || "Errore";
      return;
    }
    const st = s.storage || { backend: "local" };
    const isS3 = st.backend === "s3";
    const localOn = s.local_auth_enabled !== false;
    body.innerHTML = `
    <div class="set-tabs">
      <button type="button" class="active" data-pane="general"><i class="ti ti-adjustments"></i> Generale</button>
      <button type="button" data-pane="storage"><i class="ti ti-database"></i> Archiviazione</button>
      <button type="button" data-pane="auth"><i class="ti ti-shield-lock"></i> Autenticazione</button>
      <button type="button" data-pane="geoip"><i class="ti ti-world"></i> GeoIP</button>
    </div>

    <div class="set-pane" data-pane="general">
      <label>Titolo del sito</label>
      <input type="text" id="set_title" value="${esc(s.site_title)}" maxlength="40" placeholder="Share">
      <label style="margin-top:10px">Intervallo di sincronizzazione note (ms)</label>
      <input type="text" id="set_poll" value="${s.note_poll_ms}">
      <label style="margin-top:10px">Dimensione massima di una nota (MB)</label>
      <input type="text" id="set_maxmb" value="${Math.round(s.note_max_bytes / 1048576)}">
      <label style="margin-top:10px">Quota predefinita per nuovo utente (MB, 0 = illimitata)</label>
      <input type="text" id="set_defquota" value="${Math.round((s.default_quota_bytes || 0) / 1048576)}">
    </div>

    <div class="set-pane" data-pane="storage" hidden>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Dove vengono salvati i file caricati. S3 usa uno storage esterno compatibile (es. Wasabi).</p>
      <label>Backend</label>
      <select id="set_backend">
        <option value="local"${isS3 ? "" : " selected"}>Locale (server)</option>
        <option value="s3"${isS3 ? " selected" : ""}>S3 compatibile (Wasabi)</option>
      </select>
      <div id="s3_box" style="margin-top:10px${isS3 ? "" : ";display:none"}">
        <label>Endpoint</label>
        <input type="text" id="s3_endpoint" value="${esc(st.endpoint || "")}" placeholder="s3.eu-south-1.wasabisys.com">
        <label style="margin-top:8px">Regione</label>
        <input type="text" id="s3_region" value="${esc(st.region || "")}" placeholder="eu-south-1">
        <label style="margin-top:8px">Bucket</label>
        <input type="text" id="s3_bucket" value="${esc(st.bucket || "")}" placeholder="desotech-desoshare">
        <label style="margin-top:8px">Access Key ID</label>
        <input type="text" id="s3_key" value="${esc(st.access_key || "")}" autocomplete="off">
        <label style="margin-top:8px">Secret Access Key</label>
        <input type="password" id="s3_secret" value="" autocomplete="new-password" placeholder="${st.has_secret ? "•••••••• (invariato)" : "inserisci il secret"}">
        <p class="muted" style="font-size:12px;margin:4px 0 0">Lascia vuoto il secret per non modificarlo. È salvato cifrato sul server.</p>
        <div style="margin-top:8px"><button class="btn" id="s3_testbtn"><i class="ti ti-plug-connected"></i> Prova connessione</button> <span id="s3_testmsg" class="muted" style="font-size:12px"></span></div>
      </div>
    </div>

    <div class="set-pane" data-pane="auth" hidden>
      <h3 style="margin:2px 0 4px;font-size:15px;display:flex;align-items:center;gap:6px"><i class="ti ti-key"></i> Autenticazione locale</h3>
      <label class="sw"><input type="checkbox" id="local_auth_enabled" ${localOn ? "checked" : ""}> Abilita login con username e password</label>
      <p class="muted" style="font-size:12px;margin:4px 0 0">Se disattivata, l'accesso sarà possibile <b>solo via SSO</b>: assicurati che l'SSO sia abilitato e funzionante, altrimenti rischi di restare fuori.</p>
      ${oidcSection(s.oidc || {})}
    </div>

    <div class="set-pane" data-pane="geoip" hidden>
      <h3 style="margin:2px 0 4px;font-size:15px;display:flex;align-items:center;gap:6px"><i class="ti ti-world"></i> Posizione degli accessi (GeoIP)</h3>
      <p class="muted" style="font-size:12px;margin:4px 0 10px">Il registro mostra da dove arriva ogni accesso usando un database locale (DB-IP City Lite, gratuito): nessun indirizzo IP viene inviato a servizi esterni. Il database va aggiornato circa una volta al mese.</p>
      ${geoipStatus(s.geoip || {})}
      <div style="margin-top:10px"><button class="btn" id="geoip_update"><i class="ti ti-download"></i> ${s.geoip && s.geoip.installed ? "Aggiorna il database" : "Scarica il database"} (circa 60 MB)</button> <span id="geoip_msg" class="muted" style="font-size:12px"></span></div>
      <p class="muted" style="font-size:11px;margin:10px 0 0">IP Geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a> (CC BY 4.0). Posizione approssimativa, a livello di città o di provider.</p>
    </div>`;
    modalBg.querySelectorAll(".set-tabs button").forEach((b) => b.onclick = () => {
      modalBg.querySelectorAll(".set-tabs button").forEach((x) => x.classList.toggle("active", x === b));
      modalBg.querySelectorAll(".set-pane").forEach((p) => {
        p.hidden = p.dataset.pane !== b.dataset.pane;
      });
    });
    const gBtn = $("#geoip_update", modalBg);
    if (gBtn) gBtn.onclick = async () => {
      const msg = $("#geoip_msg", modalBg);
      gBtn.disabled = true;
      msg.textContent = "download in corso, può richiedere un minuto…";
      const r = await apiPost("geoip_update", {});
      gBtn.disabled = false;
      if (r.ok) {
        toast("Database GeoIP aggiornato (" + r.build + ")");
        adminPanel("settings");
      } else {
        msg.textContent = r.error || "Errore";
        toast(r.error || "Errore", true);
      }
    };
    const backendSel = $("#set_backend", modalBg);
    backendSel.onchange = () => {
      $("#s3_box", modalBg).style.display = backendSel.value === "s3" ? "" : "none";
    };
    const s3fields = () => ({
      storage_backend: backendSel.value,
      s3_endpoint: $("#s3_endpoint", modalBg) ? $("#s3_endpoint", modalBg).value : "",
      s3_region: $("#s3_region", modalBg) ? $("#s3_region", modalBg).value : "",
      s3_bucket: $("#s3_bucket", modalBg) ? $("#s3_bucket", modalBg).value : "",
      s3_key: $("#s3_key", modalBg) ? $("#s3_key", modalBg).value : "",
      s3_secret: $("#s3_secret", modalBg) ? $("#s3_secret", modalBg).value : ""
    });
    const testBtn = $("#s3_testbtn", modalBg);
    if (testBtn) testBtn.onclick = async () => {
      const msg = $("#s3_testmsg", modalBg);
      msg.textContent = "verifica in corso…";
      msg.style.color = "";
      const r = await apiPost("s3_test", s3fields());
      msg.textContent = r.ok ? r.message || "Connessione riuscita" : r.error || "Connessione fallita";
      msg.style.color = r.ok ? "var(--ok, #1a7f37)" : "var(--danger, #c0392b)";
    };
    const ssoEnabled = $("#oidc_enabled", modalBg);
    if (ssoEnabled) ssoEnabled.onchange = () => {
      $("#oidc_box", modalBg).style.display = ssoEnabled.checked ? "" : "none";
    };
    const val = (id) => {
      const el = $("#" + id, modalBg);
      return el ? el.value.trim() : "";
    };
    const oidcfields = () => ({
      oidc_present: "1",
      oidc_enabled: ssoEnabled && ssoEnabled.checked ? "1" : "0",
      oidc_client_id: val("oidc_client_id"),
      oidc_secret: $("#oidc_secret", modalBg) ? $("#oidc_secret", modalBg).value : "",
      oidc_issuer: val("oidc_issuer"),
      oidc_authz: val("oidc_authz"),
      oidc_token: val("oidc_token"),
      oidc_userinfo: val("oidc_userinfo"),
      oidc_jwks: val("oidc_jwks"),
      oidc_endsession: val("oidc_endsession"),
      oidc_redirect: val("oidc_redirect"),
      oidc_scopes: val("oidc_scopes"),
      oidc_admin_group: val("oidc_admin_group"),
      oidc_rw_group: val("oidc_rw_group")
    });
    const disco = $("#oidc_disco", modalBg);
    if (disco) disco.onclick = async () => {
      const msg = $("#oidc_discomsg", modalBg);
      msg.textContent = "lettura discovery…";
      msg.style.color = "";
      const r = await apiPost("oidc_discovery", { issuer: val("oidc_issuer") });
      if (!r.ok) {
        msg.textContent = r.error || "Discovery fallita";
        msg.style.color = "var(--danger, #c0392b)";
        return;
      }
      const d = r.discovery;
      const set = (id, v) => {
        const el = $("#" + id, modalBg);
        if (el && v) el.value = v;
      };
      set("oidc_authz", d.authz);
      set("oidc_token", d.token);
      set("oidc_userinfo", d.userinfo);
      set("oidc_jwks", d.jwks);
      set("oidc_endsession", d.endsession);
      msg.textContent = "Endpoint compilati dal discovery ✓";
      msg.style.color = "var(--ok, #1a7f37)";
    };
    const ssoTest = $("#oidc_testbtn", modalBg);
    if (ssoTest) ssoTest.onclick = async () => {
      const msg = $("#oidc_testmsg", modalBg);
      msg.textContent = "verifica in corso…";
      msg.style.color = "";
      const r = await apiPost("oidc_test", oidcfields());
      msg.textContent = r.ok ? r.message || "OK" : r.error || "Verifica fallita";
      msg.style.color = r.ok ? "var(--ok, #1a7f37)" : "var(--danger, #c0392b)";
    };
    $("#adm_save", modalBg).onclick = async () => {
      if (backendSel.value !== (st.backend || "local") && !confirm("Stai cambiando l'archiviazione dei file.\n\nI file NON vengono spostati: quelli esistenti restano dove sono e non saranno visibili finché non vengono copiati nella nuova archiviazione. I link di condivisione degli elementi non trovati smetteranno di funzionare.\n\nContinuare?")) return;
      const r = await apiPost("settings_save", Object.assign({
        site_title: $("#set_title", modalBg).value,
        note_poll_ms: $("#set_poll", modalBg).value,
        note_max_mb: $("#set_maxmb", modalBg).value,
        default_quota_mb: $("#set_defquota", modalBg).value,
        local_auth_enabled: $("#local_auth_enabled", modalBg) && $("#local_auth_enabled", modalBg).checked ? "1" : "0"
      }, s3fields(), oidcfields()));
      if (r.ok) toast("Impostazioni salvate");
      else toast(r.error || "Errore", true);
    };
  }
  async function renderAuditSection(body) {
    body.innerHTML = `<p class="muted" style="margin:0 0 10px">Operazioni di gestione (utenti, impostazioni, condivisioni). Gli accessi ai file sono nella pagina <a href="index.php?view=registro">Registro</a>.</p><div id="reg_body"></div>`;
    const host = $("#reg_body", body);
    const r = await apiGet("audit_list");
    if (!r.ok) {
      host.textContent = r.error || "Errore";
      return;
    }
    if (!r.entries.length) {
      host.innerHTML = '<p class="muted">Nessuna attività registrata.</p>';
      return;
    }
    host.innerHTML = `<table class="utable">
    <thead><tr><th>Quando</th><th>Utente</th><th>Azione</th><th>Dettaglio</th></tr></thead><tbody>${r.entries.map((e) => `<tr><td style="white-space:nowrap">${esc(fmtTime(e.time))}</td><td>${esc(e.user)}</td><td>${esc(e.action)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join("")}</tbody></table>`;
  }
  function geoipStatus(g) {
    if (!g.installed) return '<p class="alert" style="margin:0">Database non installato: nel registro la colonna «Da dove» resta vuota.</p>';
    if (g.error) return `<p class="alert" style="margin:0">${esc(g.error)}</p>`;
    const stale = g.stale ? ' <span class="badge badge-r">da aggiornare</span>' : ' <span class="badge badge-w">aggiornato</span>';
    return `<p style="margin:0">Database <b>${esc(g.type || "")}</b> del <b>${esc(g.build || "")}</b> (${esc(String(g.age_days))} giorni fa, ${esc(fmtBytes(g.size || 0))})${stale}</p>`;
  }
  function userForm(u = null) {
    const editing = !!u;
    const perm = u ? u.permission : "read";
    const isAdminRole = u ? u.role === "admin" : false;
    openModal(`<div class="modal"><h3><i class="ti ti-user-plus"></i> ${editing ? "Modifica utente" : "Nuovo utente"}</h3>
    <label>Username</label><input type="text" id="u_name" value="${u ? esc(u.username) : ""}" ${editing ? "readonly" : ""}>
    <label>Password ${editing ? "(lascia vuoto per non cambiarla)" : ""}</label>
    <input type="text" id="u_pass" placeholder="${editing ? "••••••" : "almeno 6 caratteri"}">
    <label>Permessi</label>
    <div class="perm-row" id="u_perm">
      <div class="perm-opt ${perm === "read" ? "active" : ""}" data-v="read"><i class="ti ti-eye"></i> Sola lettura</div>
      <div class="perm-opt ${perm === "write" ? "active" : ""}" data-v="write"><i class="ti ti-pencil"></i> Lettura e scrittura</div>
    </div>
    <label style="margin-top:12px">Quota di archiviazione (MB, 0 = illimitata)</label>
    <input type="text" id="u_quota" value="${u && u.quota_mb ? u.quota_mb : 0}">
    <label style="margin-top:12px"><input type="checkbox" id="u_admin" ${isAdminRole ? "checked" : ""}> Amministratore (gestione utenti + accesso completo)</label>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" id="u_save">Salva</button></div></div>`);
    let chosen = perm;
    modalBg.querySelectorAll(".perm-opt").forEach((o) => o.onclick = () => {
      chosen = o.dataset.v;
      modalBg.querySelectorAll(".perm-opt").forEach((x) => x.classList.toggle("active", x === o));
    });
    $("#u_save", modalBg).onclick = async () => {
      const q = $("#u_quota", modalBg).value.trim();
      if (q !== "" && !/^\d+$/.test(q)) {
        toast("Quota non valida: inserisci un numero intero di MB (0 = illimitata)", true);
        return;
      }
      const data = {
        username: $("#u_name", modalBg).value.trim(),
        password: $("#u_pass", modalBg).value,
        permission: chosen,
        role: $("#u_admin", modalBg).checked ? "admin" : "user",
        quota_mb: q
      };
      if (editing) data.original = u.username;
      const r = await apiPost("user_save", data);
      if (r.ok) {
        toast("Utente salvato");
        adminPanel("users");
      } else toast(r.error || "Errore", true);
    };
  }

  // upload.js
  var CHUNK = 16 * 1024 * 1024;
  var CONC = 3;
  var MAX_RETRY = 5;
  function relDir(p) {
    if (!p) return "";
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }
  async function fileUid(dir, f) {
    const sig = [dir, f.name, f.size, f.lastModified].join("\n");
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sig));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    } catch (_) {
      let h = 0;
      for (let i = 0; i < sig.length; i++) h = h * 31 + sig.charCodeAt(i) >>> 0;
      return ("0000000" + h.toString(16)).slice(-8).repeat(2);
    }
  }
  function uploadItems(items) {
    if (!CAN_WRITE || !items.length) return;
    if (S.uploading) {
      toast("Un caricamento è già in corso: attendi che finisca", true);
      return;
    }
    closeModal();
    openModal(`<div class="modal"><h3><i class="ti ti-upload"></i> Caricamento (${items.length})</h3>
    <div id="up_list" style="max-height:340px;overflow:auto"></div>
    <div class="modal-actions"><button class="btn" id="up_close" disabled>Chiudi</button></div></div>`);
    const list = $("#up_list", modalBg);
    const rows = items.map((it) => {
      const label = (it.rel ? it.rel + "/" : "") + it.file.name;
      const row = document.createElement("div");
      row.style.margin = "10px 0";
      row.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</span>
        <span class="up-stat" style="flex:none;color:var(--muted)">in attesa</span></div>
      <div class="progress"><div></div></div>`;
      list.appendChild(row);
      return { it, bar: row.querySelector(".progress > div"), stat: row.querySelector(".up-stat"), done: false };
    });
    const closeBtn = $("#up_close", modalBg);
    const base = S.cwd;
    S.uploading = true;
    (async () => {
      try {
        for (const r of rows) {
          try {
            await uploadOne(r, base);
            r.done = true;
            r.stat.textContent = "completato";
            r.stat.style.color = "var(--ok)";
          } catch (e) {
            r.stat.textContent = "errore: " + (e.message || e);
            r.stat.style.color = "var(--danger)";
          }
        }
      } finally {
        S.uploading = false;
      }
      closeBtn.disabled = false;
      closeBtn.onclick = () => {
        closeModal();
        load(S.cwd);
      };
      load(S.cwd);
    })();
  }
  async function uploadOne(r, base) {
    const f = r.it.file;
    const dir = [base, r.it.rel].filter(Boolean).join("/");
    const uid = await fileUid(dir, f);
    if (f.size === 0) {
      const fin2 = await apiPost("upload_finish", { uid, path: dir, name: f.name, total: 0, chunk_size: CHUNK });
      if (!fin2.ok) throw new Error(fin2.error || "finalizzazione fallita");
      setProg(r, 0, 0);
      return;
    }
    let chunkSize = CHUNK;
    const doneSet = /* @__PURE__ */ new Set();
    try {
      const st = await fetch("api.php?action=upload_status&uid=" + uid).then((x) => x.json());
      if (st.ok) {
        if (st.chunk > 0) chunkSize = st.chunk;
        (st.parts || []).forEach((i) => doneSet.add(i));
      }
    } catch (_) {
    }
    const count = Math.max(1, Math.ceil(f.size / chunkSize));
    const lenOf = (i) => Math.min(chunkSize, f.size - i * chunkSize);
    let doneBytes = 0;
    doneSet.forEach((i) => doneBytes += lenOf(i));
    if (doneSet.size > 0 && doneSet.size < count) r.stat.textContent = "ripresa…";
    const missing = [];
    for (let i = 0; i < count; i++) if (!doneSet.has(i)) missing.push(i);
    const live = /* @__PURE__ */ new Map();
    const refresh = () => {
      let l = 0;
      live.forEach((v) => l += v);
      setProg(r, doneBytes + l, f.size);
    };
    refresh();
    let next = 0, failed = null;
    const worker = async () => {
      while (next < missing.length && !failed) {
        const idx = missing[next++];
        const offset = idx * chunkSize, end = Math.min(offset + chunkSize, f.size);
        try {
          await sendChunk(uid, idx, offset, chunkSize, f.size, f.slice(offset, end), dir, f.name, (loaded) => {
            live.set(idx, loaded);
            refresh();
          });
          live.delete(idx);
          doneBytes += end - offset;
          refresh();
        } catch (e) {
          failed = e;
          live.delete(idx);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, missing.length || 1) }, worker));
    if (failed) throw failed;
    const fin = await apiPost("upload_finish", { uid, path: dir, name: f.name, total: f.size, chunk_size: chunkSize });
    if (!fin.ok) throw new Error(fin.error || "finalizzazione fallita");
  }
  function sendChunk(uid, index, offset, chunkSize, total, blob, dir, name, onProg, attempt = 0) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "api.php?action=upload_chunk");
      xhr.setRequestHeader("X-CSRF", CSRF);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProg) onProg(e.loaded);
      };
      const retry = () => {
        if (attempt < MAX_RETRY) setTimeout(() => sendChunk(uid, index, offset, chunkSize, total, blob, dir, name, onProg, attempt + 1).then(resolve, reject), 800 * (attempt + 1));
        else reject(new Error("connessione interrotta"));
      };
      xhr.onload = () => {
        let r = {};
        try {
          r = JSON.parse(xhr.responseText);
        } catch (_) {
        }
        if (xhr.status === 200 && r.ok) resolve(r);
        else if (xhr.status >= 500 || xhr.status === 0) retry();
        else reject(new Error(r.error || "HTTP " + xhr.status));
      };
      xhr.onerror = retry;
      const fd = new FormData();
      fd.append("uid", uid);
      fd.append("index", index);
      fd.append("offset", offset);
      fd.append("chunk_size", chunkSize);
      fd.append("total", total);
      fd.append("path", dir);
      fd.append("name", name);
      fd.append("chunk", blob);
      xhr.send(fd);
    });
  }
  function setProg(r, done, total) {
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 100;
    r.bar.style.width = pct + "%";
    if (!r.done && r.stat.style.color !== "var(--danger)") r.stat.textContent = pct + "% · " + fmtBytes(done) + " / " + fmtBytes(total);
  }
  function walkEntry(entry, parentPath) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => resolve([{ file: f, rel: parentPath }]), () => resolve([]));
      } else if (entry.isDirectory) {
        const dirPath = parentPath ? parentPath + "/" + entry.name : entry.name;
        const reader = entry.createReader();
        const acc = [];
        const read = () => reader.readEntries(async (ents) => {
          if (!ents.length) {
            const nested = await Promise.all(acc.map((e) => walkEntry(e, dirPath)));
            resolve(nested.flat());
            return;
          }
          acc.push(...ents);
          read();
        }, () => resolve([]));
        read();
      } else resolve([]);
    });
  }

  // main.js
  window.addEventListener("error", (e) => {
    try {
      toast("Errore: " + (e.message || e.error && e.error.message || e), true);
    } catch (_) {
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      toast("Errore: " + (e.reason && e.reason.message || e.reason), true);
    } catch (_) {
    }
  });
  var sbToggle = $("#sbToggle");
  if (sbToggle) sbToggle.onclick = () => {
    const collapsed = app.classList.toggle("sb-collapsed");
    try {
      localStorage.setItem("share-sb", collapsed ? "1" : "0");
    } catch (_) {
    }
    sbToggle.title = sbToggle.getAttribute("aria-label") === null ? "" : collapsed ? "Allarga la barra" : "Riduci la barra";
    sbToggle.setAttribute("aria-label", sbToggle.title);
    sbToggle.querySelector(".ti").className = "ti " + (collapsed ? "ti-layout-sidebar-left-expand" : "ti-layout-sidebar-left-collapse");
  };
  $("#btnShares") && ($("#btnShares").onclick = sharesPanel);
  $("#btnTrash") && ($("#btnTrash").onclick = () => trashPanel());
  if (IS_ADMIN) $("#btnAdmin") && ($("#btnAdmin").onclick = () => adminPanel("users"));
  if (VIEW === "registro") {
    registroPage($("#registro"));
  } else {
    if (CAN_WRITE) {
      $("#btnUpload").onclick = () => $("#fileInput").click();
      $("#fileInput").onchange = (e) => {
        uploadItems(Array.from(e.target.files).map((f) => ({ file: f, rel: "" })));
        e.target.value = "";
      };
      $("#btnUploadFolder") && ($("#btnUploadFolder").onclick = () => $("#folderInput").click());
      $("#folderInput") && ($("#folderInput").onchange = (e) => {
        uploadItems(Array.from(e.target.files).map((f) => ({ file: f, rel: relDir(f.webkitRelativePath) })));
        e.target.value = "";
      });
      $("#btnNewFolder").onclick = newFolderDialog;
      $("#btnNewFile").onclick = newFileDialog;
      $("#btnNewNote") && ($("#btnNewNote").onclick = newNoteDialog);
      $("#btnDelSel") && ($("#btnDelSel").onclick = () => deleteDialog([...selected]));
    }
    $("#btnRefresh").onclick = () => load(S.cwd);
    $("#btnZipCurrent").onclick = () => startZip(selected.size ? [...selected] : [S.cwd || ""]);
    $("#btnZipSel").onclick = () => startZip([...selected]);
    searchEl.oninput = renderRows;
    $("#checkAll").onchange = (e) => {
      const filter = searchEl.value.trim().toLowerCase();
      S.items.filter((it) => !filter || it.name.toLowerCase().includes(filter)).forEach((it) => {
        const rel = (S.cwd ? S.cwd + "/" : "") + it.name;
        e.target.checked ? selected.add(rel) : selected.delete(rel);
      });
      renderRows();
      updateSelbar();
    };
    let dragDepth = 0;
    if (CAN_WRITE) {
      window.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth++;
        document.body.classList.add("dragging");
      });
      window.addEventListener("dragover", (e) => e.preventDefault());
      window.addEventListener("dragleave", (e) => {
        e.preventDefault();
        if (--dragDepth <= 0) document.body.classList.remove("dragging");
      });
      window.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove("dragging");
        const dt = e.dataTransfer;
        const entries = dt.items && dt.items.length && dt.items[0].webkitGetAsEntry ? Array.from(dt.items).map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean) : [];
        if (entries.length) {
          Promise.all(entries.map((en) => walkEntry(en, ""))).then((lists) => {
            const items = lists.flat();
            if (items.length) uploadItems(items);
          });
        } else if (dt.files && dt.files.length) {
          uploadItems(Array.from(dt.files).map((f) => ({ file: f, rel: "" })));
        }
      });
    }
    load("");
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalBg.hidden) closeModal();
  });
})();
