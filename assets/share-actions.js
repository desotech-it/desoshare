// Azioni della pagina PUBBLICA di una cartella condivisa con livello collaboratore
// o gestione completa: rinomina, elimina, nuova cartella. Autenticate dal token
// del link (parametro t) e, se il link ha un PIN, dalla sessione sbloccata con
// l'header X-CSRF. I permessi li decide il server (api_link.php): qui si mostrano
// solo le icone che il server ha già concesso riga per riga.
// Espone window.ShareActions.mount({token, path, csrf, days}).
(function () {
  function post(o, action, fields) {
    const fd = new FormData();
    for (const k in fields) fd.append(k, fields[k]);
    return fetch('api.php?action=' + action + '&t=' + encodeURIComponent(o.token), { method: 'POST', headers: { 'X-CSRF': o.csrf || '' }, body: fd })
      .then(r => r.json().catch(() => ({ ok: false, error: 'Errore HTTP ' + r.status })));
  }
  function mount(o) {
    const msg = document.getElementById('shMsg');
    const fail = text => { if (msg) { msg.textContent = text; msg.hidden = false; window.scrollTo(0, 0); } else alert(text); };
    const done = r => {
      if (r && r.ok && !(r.errors && r.errors.length)) { location.reload(); return; }
      fail((r && (r.error || (r.errors || []).join(' · '))) || 'Operazione non riuscita');
    };
    const offline = () => fail('Connessione non riuscita: riprova');
    document.querySelectorAll('.share-row .js-ren').forEach(b => b.addEventListener('click', () => {
      const row = b.closest('.share-row');
      const name = prompt('Nuovo nome per «' + row.dataset.name + '»', row.dataset.name);
      if (name === null || !name.trim() || name.trim() === row.dataset.name) return;
      post(o, 'link_rename', { from: row.dataset.rel, to: name.trim() }).then(done, offline);
    }));
    document.querySelectorAll('.share-row .js-del').forEach(b => b.addEventListener('click', () => {
      const row = b.closest('.share-row');
      const days = o.days || 30;
      if (!confirm('Eliminare «' + row.dataset.name + '»?\n\nResterà recuperabile dal proprietario della cartella per ' + days + ' giorni.')) return;
      post(o, 'link_delete', { paths: JSON.stringify([row.dataset.rel]) }).then(done, offline);
    }));
    const mk = document.getElementById('shMkdir');
    if (mk) mk.addEventListener('click', () => {
      const name = prompt('Nome della nuova cartella');
      if (name === null || !name.trim()) return;
      post(o, 'link_mkdir', { path: o.path || '', name: name.trim() }).then(done, offline);
    });
  }
  window.ShareActions = { mount };
})();
