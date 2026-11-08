/* AutoLeo - sincronizacion con Supabase.
   Regla: el telefono manda. Todo se guarda primero en local y luego se sube.
   Si no hay red, la app sigue igual y lo pendiente sube cuando vuelva. */
(function () {
  const URL_BASE = 'https://vzeqzdxleclivrkctwvb.supabase.co';
  const LLAVE = 'sb_publishable_M3amZQW7hGZUiO5ePZ4yog_-IS6ERNX';
  const SKEY = 'autoleo.sesion';

  let sesion = null;
  let timer = null;
  let subiendo = false;
  let pendiente = false;

  function marca(txt, clase) {
    const el = document.getElementById('nube');
    if (!el) return;
    el.textContent = txt;
    el.title = txt;
    el.className = clase || '';
  }

  function esUUID(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  /* ids locales viejos ("p1699...") pasan a uuid, sin perder sus muestras */
  function normalizarIds() {
    const e = App.estado;
    let cambios = false;
    const mapa = {};
    for (const p of e.palabras) {
      if (!esUUID(p.id)) { const n = uuid(); mapa[p.id] = n; p.id = n; cambios = true; }
    }
    for (const v of (e.voces || [])) {
      if (mapa[v.etiqueta]) { v.etiqueta = mapa[v.etiqueta]; cambios = true; }
      if (!esUUID(v.id)) { v.id = uuid(); cambios = true; }
    }
    for (const h of (e.historial || [])) {
      if (!esUUID(h.id)) { h.id = uuid(); h.t = h.t || Date.now(); cambios = true; }
    }
    if (cambios) App.guardar();
  }

  async function guardarSesion(j) {
    const u = j.user || j;
    sesion = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + 3600),
      user_id: u && u.id
    };
    localStorage.setItem(SKEY, JSON.stringify(sesion));
    return sesion;
  }

  async function entrar() {
    if (sesion && sesion.expires_at * 1000 > Date.now() + 60000) return sesion;
    try {
      const guardada = JSON.parse(localStorage.getItem(SKEY) || 'null');
      if (guardada && guardada.refresh_token) {
        const r = await fetch(URL_BASE + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { apikey: LLAVE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: guardada.refresh_token })
        });
        if (r.ok) return guardarSesion(await r.json());
      }
    } catch (e) {}

    const r = await fetch(URL_BASE + '/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: LLAVE, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || j.error_description || ('auth ' + r.status));
    return guardarSesion(j);
  }

  async function pedir(ruta, opts) {
    await entrar();
    const o = opts || {};
    const r = await fetch(URL_BASE + '/rest/v1/' + ruta, {
      method: o.method || 'GET',
      headers: {
        apikey: LLAVE,
        Authorization: 'Bearer ' + sesion.access_token,
        'Content-Type': 'application/json',
        Prefer: o.prefer || 'return=minimal'
      },
      body: o.body ? JSON.stringify(o.body) : undefined
    });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 140));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }

  function aIso(t) {
    const d = t ? new Date(t) : new Date();
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  /* ---------- subir ---------- */
  async function subir() {
    const e = App.estado;
    const palabras = (e.palabras || []).map(p => ({
      id: p.id, frase: p.frase, dice: p.dice || '', em: p.em || '🗣️', actualizado: aIso(p.act)
    }));
    if (palabras.length) {
      await pedir('palabras?on_conflict=id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: palabras
      });
    }
    const muestras = (e.voces || []).map(v => ({
      id: v.id, palabra_id: v.etiqueta, huella: v.p || v.huella, creado: aIso(v.t || v.creado)
    }));
    if (muestras.length) {
      await pedir('muestras?on_conflict=id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: muestras
      });
    }
    const hist = (e.historial || []).map(h => ({
      id: h.id, frase: h.fr, dice: h.qu || '', em: h.em || '', ts: aIso(h.t)
    }));
    if (hist.length) {
      await pedir('historial?on_conflict=id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: hist
      });
    }
  }

  /* ---------- bajar y mezclar ---------- */
  async function bajar() {
    const e = App.estado;
    const [pals, mues, hist] = await Promise.all([
      pedir('palabras?select=*'),
      pedir('muestras?select=*'),
      pedir('historial?select=*&order=ts.desc&limit=60')
    ]);

    let cambio = false;
    const porId = {};
    (e.palabras || []).forEach(p => { porId[p.id] = p; });

    for (const r of pals || []) {
      const l = porId[r.id];
      if (!l) {
        e.palabras.push({ id: r.id, frase: r.frase, dice: r.dice || '', em: r.em || '🗣️', act: r.actualizado });
        cambio = true;
      } else if (r.actualizado && (!l.act || new Date(r.actualizado) > new Date(l.act))) {
        l.frase = r.frase; l.dice = r.dice || ''; l.em = r.em || '🗣️'; l.act = r.actualizado;
        cambio = true;
      }
    }

    const vocesId = {};
    (e.voces || []).forEach(v => { vocesId[v.id] = v; });
    for (const m of mues || []) {
      if (!vocesId[m.id]) {
        e.voces.push({ id: m.id, etiqueta: m.palabra_id, p: m.huella, t: new Date(m.creado).getTime() });
        cambio = true;
      }
    }

    const histId = {};
    (e.historial || []).forEach(h => { histId[h.id] = h; });
    const juntos = (e.historial || []).slice();
    for (const h of hist || []) {
      if (!histId[h.id]) { juntos.push({ id: h.id, fr: h.frase, qu: h.dice || '', em: h.em || '', t: new Date(h.ts).getTime() }); cambio = true; }
    }
    e.historial = juntos.sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 12);

    if (cambio) {
      App.guardar();
      if (window.Mic && Mic.pintarPalabras) Mic.pintarPalabras();
      App.pintarHistorial();
    }
    return cambio;
  }

  async function ciclo() {
    if (subiendo || !navigator.onLine) { pendiente = true; marca('☁️ sin red', 'off'); return; }
    subiendo = true;
    marca('☁️ guardando…', '');
    try {
      await entrar();
      await subir();
      await bajar();
      marca('☁️ al día', 'ok');
      pendiente = false;
    } catch (e) {
      marca('☁️ sin conectar', 'off');
      pendiente = true;
      console.warn('sync', e.message);
    } finally {
      subiendo = false;
    }
  }

  function encolar(ms) {
    clearTimeout(timer);
    timer = setTimeout(ciclo, ms || 1500);
  }

  async function iniciar() {
    normalizarIds();
    if (!navigator.onLine) { marca('☁️ sin red', 'off'); return; }
    await ciclo();
  }

  addEventListener('online', () => encolar(500));
  addEventListener('offline', () => marca('☁️ sin red', 'off'));

  window.Supa = {
    iniciar, encolar, ciclo, subir, bajar, entrar, marca,
    get sesion() { return sesion; },
    get pendiente() { return pendiente; },
    _uuid: uuid
  };
})();
