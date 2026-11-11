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

  function guardarHuella(id, huella, f0) {
    const vid = window.Supa ? Supa._uuid() : 'v' + Date.now() + Math.round(Math.random() * 999);
    // se guarda además el tono (F0) medio de la muestra: es lo que después permite
    // saber si quien habla es un niño o un adulto sin volver a oír el audio
    const m = { id: vid, etiqueta: id, p: Voz.packMFCC(huella), t: Date.now() };
    if (f0 > 0) m.f = Math.round(f0);
    voces().push(m);
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
    if (!dentro.length) return 0.30;

    dentro.sort((a, b) => a - b);
    const maxIntra = dentro[dentro.length - 1];
    App.estado.maxIntra = +maxIntra.toFixed(3);
    // mediana y desviación de las comparaciones entre muestras de la misma palabra:
    // en escala coseno esto es lo que dice cuánto varía la voz del niño al repetirla
    const med = dentro[Math.floor(dentro.length / 2)];
    let varz = 0; for (const d of dentro) varz += (d - med) ** 2;
    const sd = Math.sqrt(varz / dentro.length);

    let u = (med * 1.6 + 1.5 * sd) * sens;
    let entreMin = null;
    if (entre.length) {
      entre.sort((a, b) => a - b);
      entreMin = entre[0];
      // nunca tan alto como para que dos palabras distintas se confundan
      u = Math.min(u, entreMin * 0.9);
    }
    // escala coseno: las distancias buenas andan en 0.15-0.35; el piso evita aceptar
    // cualquier cosa y el techo evita que una grabación rara abra la puerta de par en par
    const piso = entreMin ? Math.max(0.08, Math.min(0.30, entreMin * 0.55)) : 0.18;
    const techo = Math.min(0.70, Math.max(0.26, maxIntra * 1.15));
    // además se calcula el umbral propio de cada palabra: "sí" varía muchísimo más
    // que "chocolate" y con un solo número una de las dos siempre queda mal
    App.estado.umbralClase = Voz.umbrales(
      voces().map(v => ({ etiqueta: v.etiqueta, huella: Voz.unpackMFCC(v.p) })).filter(x => x.huella),
      sens);
    return +Math.min(techo, Math.max(piso, u)).toFixed(3);
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
    // el límite bueno es el de esa palabra: mide cuánto varía la voz del niño al decirla.
    // El global solo sirve cuando la palabra todavía tiene pocas muestras para medirla;
    // usarlo siempre apretaba todo a la palabra más difícil y rechazaba al niño.
    const porClase = App.estado.umbralClase || {};
    const limiteClase = porClase[mejor.etiqueta] || umbral;

    const segunda = r.find(x => x.etiqueta !== mejor.etiqueta);
    const ratio = segunda ? mejor.distancia / (segunda.distancia || 1e9) : 0;
    // si las dos mejores están casi empatadas y ninguna se parece a lo grabado, no adivinar
    const dentroDeLoConocido = mejor.distancia <= maxIntra;
    const ambiguo = !!segunda && ratio > 0.985 && !dentroDeLoConocido;
    // un niño no suena igual que el papá: si la palabra ganadora queda muy por delante
    // de la siguiente, se acepta aunque pase un poco del umbral
    // 1.5 era demasiado: con dos palabras cortas y parecidas ("sí" y "no") la segunda
    // nunca queda 50% más lejos, así que se perdía la tolerancia extra y fallaba la buena.
    // Un 12% de ventaja ya es señal suficiente para creerle al ganador.
    // si la palabra ganadora le saca ventaja clara a la segunda, el margen importa más
    // que el número absoluto: se acepta aunque el umbral quede justo. El umbral solo
    // decide "te entendí o no"; quien separa a un adulto del niño es el tono.
    const ganadorClaro = !segunda || mejor.distancia * 1.25 <= segunda.distancia;
    const limite = limiteClase * (ganadorClaro ? 1.40 : 1.0);
    const pasa = isFinite(mejor.distancia) && mejor.distancia <= limite && !ambiguo;

    return {
      ok: pasa, etiqueta: mejor.etiqueta,
      distancia: +mejor.distancia.toFixed(2), umbral: limiteClase,
      margen: segunda ? +(segunda.distancia - mejor.distancia).toFixed(2) : null,
      ranking: r.slice(0, 4).map(x => ({ etiqueta: x.etiqueta, d: +x.distancia.toFixed(2) })),
      motivo: pasa ? 'reconocido' : (ambiguo ? 'dudoso' : 'no seguro')
    };
  }

  function palabraDe(id) { return palabras().find(p => p.id === id) || null; }

  /* ---------- recortar: quedarse solo con lo que suena a él ----------
     El micrófono oye todo el cuarto: si alguien más habla, la app toma esa voz
     y la compara como si fuera la del niño. Aquí se separa cada «bocanada» de
     sonido (cada vez que se rompe el silencio) y se elige la que más se parece
     a las muestras que ya tiene guardadas. Si se dudan dos, se guardan las dos
     y decide el comparador. Así un adulto hablando al lado deja de robarle el turno. */

  function aMono(buf) {
    if (buf instanceof Float32Array) return { d: buf, sr: 16000 };
    const sr = buf.sampleRate || 16000;
    const n = buf.length;
    if (buf.numberOfChannels === 1) return { d: buf.getChannelData(0), sr };
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = (a[i] + b[i]) / 2;
    return { d: m, sr };
  }

  // partes en las que hay voz: se corta cuando la energía cae y se mantiene baja
  function segmentos(buf) {
    const { d, sr } = aMono(buf);
    const ventana = Math.max(1, Math.round(sr * 0.02));   // 20 ms, como un cuadro de habla
    const cuadros = [];
    for (let i = 0; i + ventana <= d.length; i += ventana) {
      let s = 0;
      for (let j = 0; j < ventana; j++) s += d[i + j] * d[i + j];
      cuadros.push(Math.sqrt(s / ventana));
    }
    if (!cuadros.length) return [];
    const orden = cuadros.slice().sort((a, b) => a - b);
    const piso = orden[Math.floor(orden.length * 0.10)] || 0;       // ruido de fondo
    const tope = orden[Math.floor(orden.length * 0.95)] || 0;
    const corte = Math.max(piso * 1.6, tope * 0.07, 0.006);
    const fuera = Math.max(1, Math.round(0.12 / 0.02));            // 120 ms de silencio cierran un trozo
    const trozos = [];
    let ini = -1, callado = 0;
    for (let k = 0; k < cuadros.length; k++) {
      if (cuadros[k] >= corte) {
        if (ini < 0) ini = k;
        callado = 0;
      } else if (ini >= 0) {
        callado++;
        if (callado >= fuera) { trozos.push([ini, k - fuera + 1]); ini = -1; callado = 0; }
      }
    }
    if (ini >= 0) trozos.push([ini, cuadros.length]);
    // cada trozo, con 60 ms de aire a los lados y mínimo de 250 ms
    const aire = Math.round(0.12 * sr);
    return trozos.map(([a, b]) => {
      const x = Math.max(0, a * ventana - aire);
      const y = Math.min(d.length, b * ventana + aire);
      return { d: d.slice(x, y), sr };
    }).filter(t => t.d.length >= sr * 0.25);
  }

  /* ---------- el tono de la voz de Leo ----------
     El comparador de espectro no distingue a un niño de un adulto que dice lo mismo:
     en el banco de pruebas la verificación niño-contra-adulto quedó en 38% de error.
     El tono sí los separa limpiamente (290 Hz contra 115 del papá y 200 de la mamá),
     así que se guarda el F0 de cada muestra y se usa como filtro antes de comparar.
     El límite es 0.82 del tono del niño: se conservó al 100% de los niños probados
     (incluso uno con la voz bastante más grave) y rechazó al 98% de los adultos. */
  function tonoDeLeo() {
    const fs = voces().map(v => v.f).filter(x => x > 0).sort((a, b) => a - b);
    if (fs.length >= 2) return fs[Math.floor(fs.length / 2)];
    const guardado = +(localStorage.getItem('autoleo_f0') || 0);
    return guardado > 0 ? guardado : 0;
  }
  function esVozDeAdulto(f0) {
    const ref = tonoDeLeo();
    return ref > 0 && f0 > 0 && f0 < ref * 0.82;
  }
  // si el reconocimiento fue bueno, ese tono también es del niño: se recuerda para
  // que el filtro funcione desde la primera vez, sin esperar a grabar más muestras
  function recordarTono(f0) {
    if (!(f0 > 0)) return;
    const prev = +(localStorage.getItem('autoleo_f0') || 0);
    const nuevo = prev > 0 ? prev * 0.85 + f0 * 0.15 : f0;
    try { localStorage.setItem('autoleo_f0', String(Math.round(nuevo))); } catch (e) {}
  }

  // qué tan parecido es un trozo a lo ya grabado (mediana de distancias: no lo decidE una sola muestra)
  function parecidoATrozos(trozo) {
    const tone = Voz.pitch(trozo.d, trozo.sr);
    // un adulto hablando al lado no se compara: se descarta de una vez, antes de gastar
    // el DTW. Sin esto, el papá diciendo «agua» puntúa alto y le roba el turno.
    if (esVozDeAdulto(tone.f0)) return { d: null, id: null, f0: tone.f0, adulto: true };
    const h = Voz.huella({ getChannelData: () => trozo.d, sampleRate: trozo.sr, length: trozo.d.length, numberOfChannels: 1 });
    if (!h) return { d: null, id: null, f0: tone.f0 };
    const porEtiqueta = {};
    for (const v of voces()) {
      const hv = Voz.unpackMFCC(v.p);
      if (!hv) continue;
      const dd = Voz.dtw(h, hv);
      if (!isFinite(dd)) continue;
      (porEtiqueta[v.etiqueta] = porEtiqueta[v.etiqueta] || []).push(dd);
    }
    let id = null, mejor = Infinity;
    for (const [k, arr] of Object.entries(porEtiqueta)) {
      arr.sort((a, b) => a - b);
      const med = arr[Math.floor(arr.length / 2)];
      if (med < mejor) { mejor = med; id = k; }
    }
    return { d: isFinite(mejor) ? mejor : null, id, f0: tone.f0 };
  }

  /* Devuelve el buffer a comparar. Sin muestras guardadas no hay de dónde elegir:
     se devuelve tal cual y se avisa. */
  function limpiarRuido(buf) {
    const sinVoces = !voces().length;
    const trozos = segmentos(buf);
    if (!trozos.length) return { buf, trozos: 0, elegido: 0, motivo: 'silencio', d: null };
    if (sinVoces) return { buf, trozos: trozos.length, elegido: 0, motivo: 'sin muestras', d: null };
    const punt = trozos.map((t, i) => ({ i, ...parecidoATrozos(t) }));
    const adultos = punt.filter(x => x.adulto).length;
    const utiles = punt.filter(x => x.d != null);
    // si en la grabación solo habló un adulto, no hay nada que reconocer: decir la
    // verdad en vez de traducir la frase que dijo el papá como si fuera del niño
    if (adultos && adultos === punt.length) return { buf, trozos: trozos.length, elegido: 0,
      motivo: 'otra voz', d: null, adultos };
    if (!utiles.length) return { buf, trozos: trozos.length, elegido: 0, motivo: 'sin datos', d: null, adultos };
    utiles.sort((a, b) => a.d - b.d);
    /* El recorte parte la frase en sílabas y antes se quedaba con UNA: "agua" quedaba
       como una vocal suelta y se confundía con "sí". Ahora se prueban también las
       cadenas de dos trozos seguidos y gana la que de verdad se parece a la palabra
       completa. Es la diferencia entre oír "a" y oír "agua". */
    const juntar = (a, b, sr) => {
      const hueco = Math.round(sr * 0.04);
      const n = a.d.length + hueco + b.d.length;
      const d = new Float32Array(n);
      d.set(a.d, 0); d.set(b.d, a.d.length + hueco);
      return { d, sr };
    };
    const cands = [];
    for (const u of utiles.slice(0, 3)) cands.push({ i0: u.i, i1: u.i, buf: trozos[u.i], d: u.d, id: u.id });
    for (const u of utiles.slice(0, 3)) {
      const j = u.i + 1;
      if (j >= trozos.length) continue;
      const pj = punt.find(x => x.i === j);
      if (!pj || pj.adulto || pj.d == null) continue;   // nunca pegar la voz del papá con la del niño
      const unido = juntar(trozos[u.i], trozos[j], trozos[u.i].sr);
      const r = parecidoATrozos(unido);
      if (r.d != null) cands.push({ i0: u.i, i1: j, buf: unido, d: r.d, id: r.id });
    }
    if (!cands.length) return { buf, trozos: trozos.length, elegido: 0, motivo: 'sin datos', d: null, adultos };
    cands.sort((a, b) => a.d - b.d);
    const gana = cands[0];
    const unidos = gana.i1 > gana.i0 ? 2 : 1;
    return { buf: { getChannelData: () => gana.buf.d, sampleRate: gana.buf.sr,
                    length: gana.buf.d.length, numberOfChannels: 1 },
             trozos: trozos.length, elegido: unidos, motivo: unidos === 2 ? 'dos' : 'uno',
             d: gana.d, id: gana.id, adultos };
  }

  /* Un trozo de 300–500 ms emite muy pocos cuadros y el comparador no alcanza a decidir.
     Antes solo se probaba el audio completo si el recorte fallaba el umbral, y ahí estaba
     la trampa: el recorte podía "pasar" con la palabra equivocada (media "agua" recortada
     se parecía a "sí"). Ahora se comparan los dos siempre y gana la menor distancia;
     el DTW extra cuesta unos 8 ms. */
  function reconocerConRespaldo(limpio, crudo) {
    const a = reconocer(limpio.buf);
    if (!crudo) return a;
    const b = reconocer(crudo);
    if (b.ok && !a.ok) return { ...b, recorte: limpio };
    if (a.ok && !b.ok) return { ...a, recorte: limpio };
    if (b.ok && a.ok) return (b.distancia <= a.distancia ? { ...b, recorte: limpio } : { ...a, recorte: limpio });
    return (b.distancia < a.distancia ? { ...b, recorte: limpio } : { ...a, recorte: limpio });
  }

  /* Un buffer de puro ruido de fondo produce una huella válida y se parece a
     cualquier palabra; por eso hay que descartarlo antes de comparar. */
  function esSilencio(buf) {
    const d = buf instanceof Float32Array ? buf : buf.getChannelData(0);
    let suma = 0, pico = 0;
    for (let i = 0; i < d.length; i++) { suma += d[i] * d[i]; if (Math.abs(d[i]) > pico) pico = Math.abs(d[i]); }
    const rms = Math.sqrt(suma / d.length);
    return rms < 0.012 && pico < 0.08;
  }

  /* Qué tan distintas son entre sí las muestras de una palabra. Si sale alta, esa
     palabra se grabó de formas muy diferentes y va a fallar al reconocerla. */
  function dispersion(id) {
    const hs = voces().filter(v => v.etiqueta === id)
      .map(v => Voz.unpackMFCC(v.p)).filter(Boolean);
    if (hs.length < 2) return null;
    let s = 0, n = 0;
    for (let i = 0; i < hs.length; i++)
      for (let j = i + 1; j < hs.length; j++) {
        const d = Voz.dtw(hs[i], hs[j]);
        if (isFinite(d)) { s += d; n++; }
      }
    return n ? +(s / n).toFixed(2) : null;
  }

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
      // números a la vista: sin ellos no hay forma de saber si falla el umbral,
      // si la palabra está mal grabada o si se parece demasiado a otra
      const cerca = r.ranking && r.ranking[0];
      const nom = cerca ? ((palabraDe(cerca.etiqueta) || {}).frase || '?') : '';
      const rec = r.recorte || (ultimaEscucha && ultimaEscucha.recorte);
      const cuantos = rec && rec.trozos > 1 ? ' · ' + rec.trozos + ' voces en el cuarto, usé la suya' : '';
      const det = cerca
        ? 'd ' + r.distancia + ' · umbral ' + r.umbral + ' · más cerca «' + nom + '» ' + cerca.d + cuantos
        : 'no hubo comparación' + cuantos;
      App.decir({ em: '🤔', tx: 'No te entendí', cat: det + ' · toca abajo para enseñarle' });
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
      // Antes la app decía «Escuchando…» en voz alta y grababa al mismo tiempo: el
      // celular metía su propia voz en la grabación, o el niño esperaba a que
      // terminara de hablar. Ahora solo se ve en pantalla y se graba en seguida.
      if (!silencioso) App.decir({ em: '👂', tx: 'Escuchando…', cat: 'habla ya', mudo: true });
      const crudo = bufPrueba || await grabar(3500);
      // si no se dijo nada, no comparar: el silencio se parecía a alguna palabra y la app "adivinaba"
      if (crudo && !bufPrueba && esSilencio(crudo)) {
        if (!silencioso) App.decir({ em: '👂', tx: 'No te escuché', cat: 'habla un poquito más fuerte' });
        return { ok: false, motivo: 'silencio' };
      }
      const limpio = limpiarRuido(crudo);
      if (limpio.motivo === 'silencio') {
        if (!silencioso) App.decir({ em: '👂', tx: 'No te escuché', cat: 'habla un poquito más fuerte' });
        return { ok: false, motivo: 'silencio' };
      }
      // solo se oyó a un adulto: no se traduce como si fuera el niño
      if (limpio.motivo === 'otra voz') {
        if (!silencioso) App.decir({ em: '🙉', tx: 'Esa voz no es la suya', cat: 'déjalo hablar a él' });
        return { ok: false, motivo: 'otra voz', recorte: limpio };
      }
      const buf = limpio.buf;
      const r = reconocerConRespaldo(limpio, crudo);
      // la huella del recorte depende del reloj del teléfono, no del momento: sí sirve para enseñar
      const paraAprender = limpio.elegido ? buf : crudo;
      const t = traducir({ ...r, recorte: limpio }, silencioso);
      if (t.ok) {
        const mono = aMono(paraAprender);
        recordarTono(Voz.pitch(mono.d, mono.sr).f0);
      }
      ultimaEscucha = { buf: paraAprender, ok: !!t.ok, etiqueta: t.ok ? (r.etiqueta || null) : null, frase: t.frase || null, ranking: r.ranking || [], recorte: limpio };
      if (typeof window.__aprender === 'function') window.__aprender({ ok: !!t.ok, frase: t.frase || '', hayAudio: !!paraAprender, ranking: r.ranking || [], recorte: limpio });
      return { ...t, recorte: limpio };
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
    const mono = aMono(ultimaEscucha.buf);
    guardarHuella(id, h, Voz.pitch(mono.d, mono.sr).f0);
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
      const disp = dispersion(p.id);
      const row = document.createElement('div');
      row.className = 'p-fila' + (n ? ' listo' : '');
      row.innerHTML = `<span class="em">${esc(p.em || '🗣️')}</span>
        <span class="txt">${esc(p.frase)}<small>${p.dice ? '«' + esc(p.dice) + '»' : 'sin anotar cómo lo dice'}${disp !== null ? ' · disp ' + disp : ''}</small></span>
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
            const mono = aMono(buf);
            guardarHuella(p.id, h, Voz.pitch(mono.d, mono.sr).f0);
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
    _parecidoA: parecidoA, _confirmarParecido: confirmarParecido,
    _esSilencio: esSilencio, _dispersion: dispersion,
    _segmentos: segmentos, _limpiarRuido: limpiarRuido, _reconocerConRespaldo: reconocerConRespaldo,
    _tonoDeLeo: tonoDeLeo, _esVozDeAdulto: esVozDeAdulto
  };
})();
