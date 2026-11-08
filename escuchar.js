/* ==========================================================================
   escuchar.js - micrófono, muestras y traducción de sus palabras
   Escucha lo que dice, lo compara con las muestras grabadas y devuelve la
   frase completa. Todo pasa en el teléfono: ningún audio se sube a ningún lado.
   ========================================================================== */
(function () {
  'use strict';

  let stream = null, ctxAudio = null;

  async function pedirMicro() {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    return stream;
  }

  async function grabar(ms) {
    const s = await pedirMicro();
    const trozos = [];
    const mr = new MediaRecorder(s);
    mr.ondataavailable = e => { if (e.data.size) trozos.push(e.data); };
    const listo = new Promise(r => { mr.onstop = r; });
    mr.start();
    await new Promise(r => setTimeout(r, ms));
    mr.stop();
    await listo;
    const blob = new Blob(trozos, { type: mr.mimeType || 'audio/webm' });
    if (!ctxAudio) ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
    return await ctxAudio.decodeAudioData(await blob.arrayBuffer());
  }

  /* ---------- almacenamiento ---------- */
  function voces() {
    if (!Array.isArray(App.estado.voces)) App.estado.voces = [];
    return App.estado.voces;
  }
  function palabras() {
    if (!Array.isArray(App.estado.palabras)) App.estado.palabras = [];
    return App.estado.palabras;
  }
  function muestrasDe(id) { return voces().filter(v => v.etiqueta === id); }

  function guardarHuella(id, huella) {
    const vid = window.Supa ? Supa._uuid() : 'v' + Date.now() + Math.round(Math.random() * 999);
    voces().push({ id: vid, etiqueta: id, p: Voz.packMFCC(huella), t: Date.now() });
    // máximo 8 muestras por palabra: las más viejas se van
    const propias = voces().filter(v => v.etiqueta === id);
    if (propias.length > 8) {
      const sobra = propias.slice(0, propias.length - 8);
      App.estado.voces = voces().filter(v => !sobra.includes(v));
    }
    App.guardar();
  }

  // borra una muestra suelta (salió mal grabada): local y en la nube
  function borrarMuestra(mid) {
    App.estado.voces = voces().filter(v => v.id !== mid);
    App.estado.umbral = calcularUmbral();
    App.guardar();
    if (window.Supa && Supa.borrar) Supa.borrar('muestras', mid);
    pintarPalabras();
  }

  /* ---------- umbral automático ----------
     Compara las muestras de una misma palabra entre sí: una grabación nueva
     debe caer cerca de ese valor. El umbral queda un poco arriba para aceptar
     variaciones, sin llegar a confundir dos palabras distintas. */
  function calcularUmbral() {
    const sens = App.estado.sens || 1.0;
    const porEtiqueta = {};
    for (const v of voces()) {
      const h = Voz.unpackMFCC(v.p);
      if (!h) continue;
      (porEtiqueta[v.etiqueta] = porEtiqueta[v.etiqueta] || []).push(h);
    }
    const etiquetas = Object.keys(porEtiqueta);

    const dentro = [], entre = [];
    for (const e of etiquetas) {
      const hs = porEtiqueta[e];
      for (let i = 0; i < hs.length; i++)
        for (let j = i + 1; j < hs.length; j++) {
          const d = Voz.dtw(hs[i], hs[j]);
          if (isFinite(d)) dentro.push(d);   // una muestra con ceros digitales devuelve NaN y tumbaba todo el umbral
        }
      for (const o of etiquetas) {
        if (o <= e) continue;
        for (const a of hs) for (const b of porEtiqueta[o]) {
          const d = Voz.dtw(a, b);
          if (isFinite(d)) entre.push(d);
        }
      }
    }
    if (!dentro.length) return 2.0;

    dentro.sort((a, b) => a - b);
    const maxIntra = dentro[dentro.length - 1];
    App.estado.maxIntra = +maxIntra.toFixed(3);

    let u = maxIntra * 1.03 * sens;
    let entreMin = null;
    if (entre.length) {
      entre.sort((a, b) => a - b);
      entreMin = entre[0];
      u = Math.min(u, entreMin * 0.98);
    }
    // el piso crece con lo distinto que son entre sí las palabras: si "agua" y "baño"
    // quedan lejos, se tolera que el niño suene distinto sin llegar a confundirlas
    const piso = entreMin ? Math.min(0.95, Math.max(0.5, entreMin * 0.55)) : 0.5;
    // El techo fijo de 1.1 quedaba por debajo de la variabilidad normal de una palabra
    // corta: "sí" da 2.0-2.2 entre grabaciones buenas de la misma persona, así que
    // ningún intento pasaba y la app contestaba "No te entendí" con la palabra correcta.
    // El techo ahora sigue a la variabilidad medida (maxIntra) en vez de ser un número fijo.
    const techo = Math.min(3.0, Math.max(1.2, maxIntra * 1.12));
    return +Math.min(techo, Math.max(piso, u)).toFixed(2);
  }

  /* ---------- aviso al grabar ----------
     Antes de guardar una muestra, mira si ese audio se parece más a otra
     palabra ya grabada. Evita el caso de anotar "baño" cuando el niño dijo
     "agua": una muestra mal etiquetada contamina el catálogo y sube el umbral. */
  function promedioCercano(h, hs, k) {
    const ds = hs.map(x => Voz.dtw(h, x)).sort((a, b) => a - b).slice(0, k || 3);
    return ds.reduce((a, b) => a + b, 0) / ds.length;
  }

  function parecidoA(h, idElegido) {
    const porEtq = {};
    for (const v of voces()) {
      const x = Voz.unpackMFCC(v.p);
      if (x) (porEtq[v.etiqueta] = porEtq[v.etiqueta] || []).push(x);
    }
    const dPropia = porEtq[idElegido] ? promedioCercano(h, porEtq[idElegido]) : null;
    let otra = null;
    for (const id in porEtq) {
      if (id === idElegido || porEtq[id].length < 2) continue;   // con 1 muestra no hay palabra con qué comparar
      const d = promedioCercano(h, porEtq[id]);
      if (!otra || d < otra.d) otra = { id, d };
    }
    if (!otra) return { otra: null, dPropia };
    const umbral = App.estado.umbral || calcularUmbral();
    const masCerca = dPropia === null || otra.d <= dPropia * 0.8;
    const aviso = masCerca && otra.d <= umbral * 1.15 ? { id: otra.id, d: +otra.d.toFixed(2) } : null;
    return { otra: aviso, dPropia: dPropia === null ? null : +dPropia.toFixed(2) };
  }

  /* ---------- reconocer ---------- */
  function reconocer(buffer) {
    const h = Voz.huella(buffer);
    if (!h) return { ok: false, motivo: 'silencio' };
    const lista = voces()
      .map(v => ({ etiqueta: v.etiqueta, huella: Voz.unpackMFCC(v.p) }))
      .filter(x => x.huella);
    if (!lista.length) return { ok: false, motivo: 'sin muestras' };

    const r = Voz.comparar(h, lista);
    const umbral = App.estado.umbral || calcularUmbral();
    const maxIntra = App.estado.maxIntra || umbral;
    const mejor = r[0];
    if (!mejor) return { ok: false, motivo: 'sin datos' };

    const segunda = r.find(x => x.etiqueta !== mejor.etiqueta);
    const ratio = segunda ? mejor.distancia / (segunda.distancia || 1e9) : 0;
    // si las dos mejores están casi empatadas y ninguna se parece a lo grabado, no adivinar
    const dentroDeLoConocido = mejor.distancia <= maxIntra;
    const ambiguo = !!segunda && ratio > 0.985 && !dentroDeLoConocido;
    // un niño no suena igual que el papá: si la palabra ganadora queda muy por delante
    // de la siguiente, se acepta aunque pase un poco del umbral
    const ganadorClaro = !segunda || mejor.distancia * 1.5 <= segunda.distancia;
    const limite = umbral * (ganadorClaro ? 1.3 : 1.0);
    const pasa = mejor.distancia <= limite && !ambiguo;

    return {
      ok: pasa, etiqueta: mejor.etiqueta,
      distancia: +mejor.distancia.toFixed(2), umbral,
      margen: segunda ? +(segunda.distancia - mejor.distancia).toFixed(2) : null,
      ranking: r.slice(0, 4).map(x => ({ etiqueta: x.etiqueta, d: +x.distancia.toFixed(2) })),
      motivo: pasa ? 'reconocido' : (ambiguo ? 'dudoso' : 'no seguro')
    };
  }

  function palabraDe(id) { return palabras().find(p => p.id === id) || null; }

  /* ---------- traducir y decir ---------- */
  function traducir(r, silencioso) {
    if (r.ok) {
      const p = palabraDe(r.etiqueta);
      const frase = (p && p.frase) || 'No lo sé';
      const dice = p && p.dice ? p.dice : '';
      App.decir({
        em: (p && p.em) || '🗣️',
        tx: frase,
        cat: dice ? 'Él dijo «' + dice + '»' : 'lo dijo clarito'
      });
      App.anotar(frase, dice, (p && p.em) || '🗣️');
      return { ok: true, frase, dice };
    }
    if (!silencioso) {
      App.decir({ em: '🤔', tx: 'No te entendí', cat: '¿era otra? toca abajo para enseñarle' });
    }
    return { ok: false };
  }

  /* ---------- escuchar una vez ---------- */
  let ultimaEscucha = null;
  async function escucharAhora(bufPrueba, silencioso) {
    const btn = document.getElementById('btnEscuchar');
    if (btn && btn.dataset.ocupado && !silencioso) return;
    if (btn) { btn.dataset.ocupado = '1'; btn.classList.add('oyendo'); btn.disabled = true; }
    try {
      if (!silencioso) App.decir({ em: '👂', tx: 'Escuchando…', cat: 'habla ahora' });
      const buf = bufPrueba || await grabar(3500);
      const r = reconocer(buf);
      const t = traducir(r, silencioso);
      ultimaEscucha = { buf, ok: !!t.ok, etiqueta: t.ok ? (r.etiqueta || null) : null, frase: t.frase || null, ranking: r.ranking || [] };
      if (typeof window.__aprender === 'function') window.__aprender({ ok: !!t.ok, frase: t.frase || '', hayAudio: !!buf, ranking: r.ranking || [] });
      return t;
    } catch (e) {
      const m = String(e && e.message || e);
      if (!silencioso) {
        if (/permission|denied|notallowed|requested device|device not found/i.test(m)) {
          App.decir({ em: '🎤', tx: 'Dale permiso al micrófono', cat: 'la primera vez hay que permitirlo' });
        } else {
          App.decir({ em: '⚠️', tx: 'Algo falló', cat: 'dale otra vez' });
        }
      } else { manos = false; avisar(); }
      return { ok: false, error: m };
    } finally {
      if (btn) { delete btn.dataset.ocupado; btn.classList.remove('oyendo'); btn.disabled = false; }
    }
  }

  /* ---------- aprender de la última escucha ----------
     Si el padre confirma que acertó, o dice cuál palabra era, el mismo audio
     se guarda como muestra nueva de esa palabra. */
  function aprender(id) {
    if (!ultimaEscucha || !ultimaEscucha.buf) return { ok: false, motivo: 'sin audio' };
    const h = Voz.huella(ultimaEscucha.buf);
    if (!h) return { ok: false, motivo: 'silencio' };
    guardarHuella(id, h);
    App.estado.umbral = calcularUmbral();
    App.guardar();
    return { ok: true, n: muestrasDe(id).length };
  }

  /* ---------- manos libres ---------- */
  let manos = false, ciclo = 0, fallos = 0;
  function avisar() {
    if (typeof window.__manosCambio === 'function') window.__manosCambio(manos);
  }
  async function correr() {
    const mi = ++ciclo;
    while (manos && mi === ciclo) {
      try {
        const r = await escucharAhora(null, true);
        if (r && r.error) { if (++fallos >= 3) { manos = false; avisar(); break; } }
        else fallos = 0;
      } catch { manos = false; avisar(); break; }
      await new Promise(r => setTimeout(r, 350));
    }
  }
  function manosLibres() {
    manos = !manos;
    fallos = 0;
    if (manos) correr(); else ciclo++;
    avisar();
    return manos;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && manos) manos = false;
  });

  /* ---------- panel de sus palabras ---------- */
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // devuelve false si el padre dice que no: así no se guarda una muestra mal etiquetada
  function confirmarParecido(h, idElegido) {
    const r = parecidoA(h, idElegido);
    if (!r.otra) return true;
    const suya = palabraDe(idElegido), otra = palabraDe(r.otra.id);
    if (!suya || !otra) return true;
    return confirm('Esto se parece más a «' + otra.frase + '».\n\n'
      + '¿Seguro que es «' + suya.frase + '»?\n\n'
      + 'Si te equivocas aquí, la app aprende mal.');
  }

  function pintarPalabras() {
    const cont = $('#listaPalabras');
    if (!cont) return;
    cont.innerHTML = '';
    const total = voces().length;
    const umbral = App.estado.umbral || calcularUmbral();
    const res = $('#resumen');
    if (res) {
      const cortas = palabras().filter(p => muestrasDe(p.id).length > 0 && muestrasDe(p.id).length < 3).length;
      const sinNada = palabras().filter(p => !muestrasDe(p.id).length).length;
      res.innerHTML = (total ? total + ' muestras · umbral ' + umbral : 'Aún no hay muestras. Graba cada palabra unas 5 veces.')
        + (cortas ? '<div class="aviso">' + cortas + (cortas === 1 ? ' palabra tiene' : ' palabras tienen') + ' menos de 3 muestras: la próxima puede fallar.</div>' : '')
        + (sinNada ? '<div class="aviso">' + sinNada + (sinNada === 1 ? ' palabra está' : ' palabras están') + ' sin ninguna muestra.</div>' : '')
        + '<div class="sens">'
        + [['Estricto', 0.92], ['Normal', 1.0], ['Tolerante', 1.08]]
            .map(([n, v]) => `<button data-sens="${v}" class="${Math.abs((App.estado.sens || 1) - v) < 0.01 ? 'sel' : ''}">${n}</button>`).join('')
        + '</div>';
      res.querySelectorAll('[data-sens]').forEach(b => b.addEventListener('click', () => {
        App.estado.sens = parseFloat(b.dataset.sens);
        App.estado.umbral = calcularUmbral();
        App.guardar(); pintarPalabras();
      }));
    }

    const ps = palabras();
    if (!ps.length) {
      cont.innerHTML = '<div class="cab">Todavía no hay palabras. Agrega la primera arriba.</div>';
      return;
    }
    for (const p of ps) {
      const n = muestrasDe(p.id).length;
      const row = document.createElement('div');
      row.className = 'p-fila' + (n ? ' listo' : '');
      row.innerHTML = `<span class="em">${esc(p.em || '🗣️')}</span>
        <span class="txt">${esc(p.frase)}<small>${p.dice ? '«' + esc(p.dice) + '»' : 'sin anotar cómo lo dice'}</small></span>
        <span class="cuenta${n && n < 3 ? ' pocas' : ''}" title="${n && n < 3 ? 'Con menos de 3 muestras el umbral sale de una sola comparación' : ''}">${n ? n + '/8' + (n < 3 ? ' · faltan ' + (3 - n) : '') : '—'}</span>
        <button class="grabar">${n ? 'otra' : 'grabar'}</button>
        <button class="ed" title="Editar">✎</button>
        <button class="del">✕</button>`;
      row.querySelector('.grabar').addEventListener('click', async ev => {
        const b = ev.currentTarget;
        if (b.disabled) return;
        b.disabled = true; b.textContent = 'oye…';
        try {
          const buf = await grabar(2200);
          const h = Voz.huella(buf);
          if (!h) { b.textContent = 'silencio'; }
          else if (!confirmarParecido(h, p.id)) {
            b.textContent = 'no guardé';
          }
          else {
            guardarHuella(p.id, h);
            App.estado.umbral = calcularUmbral();
            App.guardar();
            pintarPalabras();
            return;
          }
        } catch (e) {
          b.textContent = 'sin micro';
        }
        setTimeout(() => { b.disabled = false; b.textContent = 'grabar'; }, 1300);
      });
      row.querySelector('.ed').addEventListener('click', () => {
        if (window.App && App.abrirEditar) App.abrirEditar(p.id);
      });
      row.querySelector('.del').addEventListener('click', () => {
        if (!confirm('¿Borrar «' + p.frase + '» y sus muestras?')) return;
        const suyas = voces().filter(v => v.etiqueta === p.id);
        App.estado.palabras = palabras().filter(x => x.id !== p.id);
        App.estado.voces = voces().filter(v => v.etiqueta !== p.id);
        if (window.Supa && Supa.borrar) {
          suyas.forEach(v => Supa.borrar('muestras', v.id));
          Supa.borrar('palabras', p.id);
        }
        App.estado.umbral = calcularUmbral();
        App.guardar(); pintarPalabras();
      });
      cont.appendChild(row);
    }
  }

  window.Mic = {
    pedirMicro, grabar, reconocer, calcularUmbral, pintarPalabras,
    escucharAhora, manosLibres, traducir, aprender, borrarMuestra,
    _ultima: () => ultimaEscucha,
    _palabraDe: palabraDe, _voces: voces, _guardarHuella: guardarHuella,
    _parecidoA: parecidoA, _confirmarParecido: confirmarParecido
  };
})();
