/* ==========================================================================
   voz.js - reconocimiento de palabras propias, sin internet y sin modelos
   --------------------------------------------------------------------------
   Cómo funciona:
     1. Se graba la palabra del niño (1 a 2 segundos).
     2. El audio se convierte en una "huella": MFCC (13 números por cada
        10 milisegundos de sonido).
     3. Al usar la app, se graba otra vez, se calcula la huella y se compara
        contra todas las muestras guardadas con DTW (alineamiento en tiempo).
     4. La etiqueta con menor distancia gana, siempre que pase el umbral.

   Todo corre en el teléfono. Ningún audio se sube a ningún lado.
   ========================================================================== */
(function (global) {
  'use strict';

  const SR = 16000;          // frecuencia de trabajo
  const FRAME = 400;         // 25 ms
  const HOP = 160;           // 10 ms
  const NFFT = 512;
  const NMEL = 26;
  const NCOEF = 13;          // c0..c12

  /* ---------------- FFT ---------------- */
  const fftRe = new Float32Array(NFFT / 2);
  const fftIm = new Float32Array(NFFT / 2);
  const cosT = new Float32Array(NFFT / 2), sinT = new Float32Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) {
    cosT[i] = Math.cos(-2 * Math.PI * i / NFFT);
    sinT[i] = Math.sin(-2 * Math.PI * i / NFFT);
  }

  function fftMagnitude(frame) {
    // real input, NFFT puntos; devuelve magnitud de las NFFT/2 primeras bandas
    const n = NFFT;
    const re = new Float32Array(n), im = new Float32Array(n);
    re.set(frame.subarray(0, Math.min(frame.length, n)));
    // bit reversal
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    // mariposas
    for (let len = 2; len <= n; len <<= 1) {
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const idx = k * step;
          const wr = cosT[idx], wi = sinT[idx];
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        }
      }
    }
    const mag = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return mag;
  }

  /* ---------------- filtros mel ---------------- */
  const MEL_LOW = 60, MEL_HIGH = 7600;
  function hz2mel(f) { return 2595 * Math.log10(1 + f / 700); }
  function mel2hz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

  const melFilters = (function () {
    const lo = hz2mel(MEL_LOW), hi = hz2mel(MEL_HIGH);
    const pts = [];
    for (let i = 0; i < NMEL + 2; i++) {
      const hz = mel2hz(lo + (hi - lo) * i / (NMEL + 1));
      pts.push(Math.floor((NFFT + 1) * hz / SR));
    }
    const fs = [];
    for (let m = 1; m <= NMEL; m++) {
      const f = { start: pts[m - 1], mid: pts[m], end: pts[m + 1], w: new Float32Array(NFFT / 2) };
      for (let k = f.start; k < f.end; k++) {
        let w = 0;
        if (k <= f.mid && f.mid > f.start) w = (k - f.start) / (f.mid - f.start);
        else if (k > f.mid && f.end > f.mid) w = (f.end - k) / (f.end - f.mid);
        f.w[k] = Math.max(0, w);
      }
      fs.push(f);
    }
    return fs;
  })();

  const dctTable = (function () {
    const t = [];
    for (let k = 0; k < NCOEF; k++) {
      const row = new Float32Array(NMEL);
      for (let n = 0; n < NMEL; n++) {
        row[n] = Math.cos(Math.PI * k * (n + 0.5) / NMEL) * (k === 0 ? Math.sqrt(1 / NMEL) : Math.sqrt(2 / NMEL));
      }
      t.push(row);
    }
    return t;
  })();

  /* ---------------- utilidades de audio ---------------- */
  function resampleTo16k(data, sr) {
    if (sr === SR) return data;
    const ratio = SR / sr;
    const out = new Float32Array(Math.floor(data.length * ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i / ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, data.length - 1), f = pos - i0;
      out[i] = data[i0] * (1 - f) + data[i1] * f;
    }
    return out;
  }

  function trimSilence(x) {
    const win = 160;
    const energy = [];
    for (let i = 0; i + win <= x.length; i += win) {
      let e = 0;
      for (let j = 0; j < win; j++) e += x[i + j] * x[i + j];
      energy.push(e / win);
    }
    if (energy.length < 4) return x;

    // suavizado: evita cortar en un hueco momentáneo del sonido
    const sm = energy.map((v, i) => {
      const a = energy[Math.max(0, i - 2)], b = energy[Math.min(energy.length - 1, i + 2)];
      return (a + v + b) / 3;
    });
    const peak = Math.max(...sm);
    if (!(peak > 0)) return x;
    // Dos ajustes medidos en la app real: 8% del pico se llevaba media palabra de dos
    // sílabas ("agua" quedaba como "a" y se confundía con "sí"), y 30 ms de margen
    // metían tanto ruido que un "sí" de 17 cuadros pasaba a 24 y dejaba de reconocerse
    // (0.267 → 0.332 de distancia). 5% y 10 ms de margen: corta el silencio sin
    // comerse el ataque de la consonante.
    const thr = peak * 0.05;

    let a = 0, b = sm.length - 1;
    while (a < sm.length && sm[a] < thr) a++;
    while (b > a && sm[b] < thr) b--;
    if (a >= b) return x;

    const start = Math.max(0, a * win - win);
    const end = Math.min(x.length, (b + 1) * win + win);
    // si el recorte deja menos de 150 ms, es más seguro usar todo el audio
    if (end - start < SR * 0.15) return x;
    return x.subarray(start, end);
  }

  /* ---------------- MFCC ---------------- */
  function mfcc(x16) {
    const recortado = trimSilence(x16);
    let r = calcular(recortado);
    // si el recorte dejó muy poco audio, se usa la señal completa
    if (!r) r = calcular(x16);
    return r;
  }

  function calcular(x) {
    if (x.length < FRAME) return null;
    // pre-énfasis
    const y = new Float32Array(x.length);
    y[0] = x[0];
    for (let i = 1; i < x.length; i++) y[i] = x[i] - 0.97 * x[i - 1];

    const hann = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) hann[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FRAME - 1));

    const frames = [];
    for (let start = 0; start + FRAME <= y.length; start += HOP) {
      const fr = new Float32Array(NFFT);
      for (let i = 0; i < FRAME; i++) fr[i] = y[start + i] * hann[i];
      const mag = fftMagnitude(fr);
      const p = new Float32Array(NFFT / 2);
      for (let i = 0; i < mag.length; i++) p[i] = mag[i] * mag[i];

      const melE = new Float32Array(NMEL);
      for (let m = 0; m < NMEL; m++) {
        let s = 0;
        const f = melFilters[m];
        for (let k = f.start; k < f.end; k++) s += p[k] * f.w[k];
        melE[m] = Math.log(s + 1e-10);
      }
      const c = new Float32Array(NCOEF);
      for (let k = 0; k < NCOEF; k++) {
        let s = 0;
        const row = dctTable[k];
        for (let n = 0; n < NMEL; n++) s += row[n] * melE[n];
        c[k] = s;
      }
      frames.push(c);
    }
    if (frames.length < 8) return null;

    // normalización por media y desviación: quita volumen y micrófono
    const mean = new Float32Array(NCOEF), sd = new Float32Array(NCOEF);
    for (const f of frames) for (let k = 0; k < NCOEF; k++) mean[k] += f[k];
    for (let k = 0; k < NCOEF; k++) mean[k] /= frames.length;
    for (const f of frames) for (let k = 0; k < NCOEF; k++) sd[k] += (f[k] - mean[k]) ** 2;
    for (let k = 0; k < NCOEF; k++) sd[k] = Math.sqrt(sd[k] / frames.length) || 1;

    const out = [];
    for (const f of frames) {
      const row = new Float32Array(NCOEF);
      for (let k = 0; k < NCOEF; k++) row[k] = (f[k] - mean[k]) / sd[k];
      out.push(row);
    }
    return out;
  }

  /* ---------------- rasgos extendidos: MFCC + Δ + ΔΔ ----------------
     El MFCC dice cómo suena cada 10 ms, pero no dice *cómo cambia*. Dos palabras
     distintas pueden tener espectros parecidos en un instante y diferenciarse solo
     en la transición ("agua" frente a "aúa"). Se añaden las derivadas temporales,
     que es lo que usa un MFCC-HMM clásico por la misma razón.
     Se calculan de los 13 números que ya están guardados: las muestras viejas
     siguen sirviendo y no hay que volver a grabar nada. */
  function deltaDe(frames, N, W) {
    const n = frames.length, out = new Array(n);
    for (let t = 0; t < n; t++) {
      const row = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        let s = 0, wsum = 0;
        for (let w = 1; w <= W; w++) {
          const a = frames[Math.min(n - 1, t + w)][k];
          const b = frames[Math.max(0, t - w)][k];
          s += w * (a - b); wsum += w * w;
        }
        row[k] = s / (2 * wsum);
      }
      out[t] = row;
    }
    return out;
  }
  const _expCache = new WeakMap();
  function expandir(frames) {
    if (!frames || !frames.length || frames[0].length !== 13) return frames;
    let c = _expCache.get(frames);
    if (c) return c;
    const d1 = deltaDe(frames, 13, 2), d2 = deltaDe(d1, 13, 2);
    const out = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const r = new Float32Array(39);
      r.set(frames[i], 0); r.set(d1[i], 13); r.set(d2[i], 26);
      out[i] = r;
    }
    _expCache.set(frames, out);
    return out;
  }

  /* ---------------- DTW ---------------- */
  function dtw(h1, h2) {
    const a = expandir(h1), b = expandir(h2);
    const n = a.length, m = b.length, D = a[0].length;
    // La banda de Sakoe-Chiba no puede ser más angosta que la diferencia de duración:
    // comparando una palabra corta (16 tramas) con una de 2 s (200 tramas) el camino
    // quedaba fuera de la banda, todo salía Infinity y la distancia daba NaN.
    // Con NaN la app no reconocía NADA que durara muy distinto a lo guardado.
    const band = Math.max(12, Math.ceil(Math.abs(n - m) * 1.25) + 10,
                          Math.floor(Math.max(n, m) * 0.35));
    let prev = new Float32Array(m + 1).fill(Infinity);
    let cur = new Float32Array(m + 1).fill(Infinity);
    prev[0] = 0;
    for (let i = 1; i <= n; i++) {
      cur[0] = Infinity;
      const lo = Math.max(1, i - band), hi = Math.min(m, i + band);
      for (let j = 1; j <= m; j++) {
        if (j < lo || j > hi) { cur[j] = Infinity; continue; }
        const fa = a[i - 1], fb = b[j - 1];
        // distancia coseno: mide el ángulo entre los dos vectores de rasgos e ignora
        // la magnitud que sobrevive a la normalización. En el banco de pruebas separa
        // hablantes mejor que la euclídea (1.17x contra 1.08x) sin perder acierto.
        let dot = 0, na = 0, nb = 0;
        for (let k = 0; k < D; k++) {
          dot += fa[k] * fb[k]; na += fa[k] * fa[k]; nb += fb[k] * fb[k];
        }
        const d = 1 - dot / (Math.sqrt(na * nb) + 1e-9);
        cur[j] = d + Math.min(prev[j], prev[j - 1], cur[j - 1]);
      }
      const t = prev; prev = cur; cur = t;
    }
    // El DTW normalizado por (n+m) es indiferente a la duración: decía que un "sí" de
    // 0.2 s y un "agua" de 0.5 s se parecen igual que dos "sí". Un castigo suave por
    // diferencia de largo los separa sin exigir que el niño hable siempre igual de rápido.
    const largo = Math.abs(n - m) / (n + m);
    return prev[m] / (n + m) + 0.22 * largo;
  }

  /* ---------------- empaquetado compacto ---------------- */
  function b64FromInt8(arr) {
    // los valores negativos se guardan como bytes sin signo (0..255)
    const u = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) u[i] = arr[i] & 0xff;
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u.length; i += chunk) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function int8FromB64(b64) {
    const s = atob(b64);
    const out = new Int8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) > 127 ? s.charCodeAt(i) - 256 : s.charCodeAt(i);
    return out;
  }

  function packMFCC(frames) {
    const n = frames.length;
    const flat = new Int8Array(n * NCOEF);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < NCOEF; k++) {
        // los coeficientes ya están normalizados: caben en -8..8 con escala 12
        flat[i * NCOEF + k] = Math.max(-127, Math.min(127, Math.round(frames[i][k] * 12)));
      }
    }
    return { n, d: NCOEF, b: b64FromInt8(flat) };
  }

  function unpackMFCC(p) {
    // una muestra puede venir como objeto {n,d,b} o como ese objeto en texto JSON
    if (typeof p === 'string') {
      try { p = JSON.parse(p); } catch (e) { return null; }
    }
    if (!p || typeof p !== 'object' || typeof p.b !== 'string' || !p.n || !p.d) return null;
    let flat;
    try { flat = int8FromB64(p.b); } catch (e) { return null; }
    if (!flat || flat.length < p.n * p.d) return null;
    const frames = [];
    for (let i = 0; i < p.n; i++) {
      const row = new Float32Array(p.d);
      for (let k = 0; k < p.d; k++) row[k] = flat[i * p.d + k] / 12;
      frames.push(row);
    }
    return frames;
  }


  /* ---------------- tono (F0) por autocorrelación ----------------
     El MFCC dice «cómo suena» pero pierde la altura de la voz: un adulto puede decir
     la misma palabra con el mismo espectro y el comparador no lo nota. El tono sí
     separa: un niño anda en 240–400 Hz, un hombre en 90–160 y una mujer en 170–250.
     Se calcula por ventanas de 40 ms con autocorrelación normalizada (estilo YIN) y
     se queda con la mediana de las ventanas que de verdad tienen tono. */
  function pitch(x, sr) {
    sr = sr || SR;
    // Las consonantes (s, f, ch) son ruido de alta frecuencia y en una palabra corta
    // pueden ocupar la mitad del sonido. Ahí la autocorrelación encuentra un periodo
    // falsísimo ("más" de un niño de 288 Hz salía a 485 Hz). Se amortigua todo por
    // encima de ~1.1 kHz antes de medir.
    const k = 1 - Math.exp(-2 * Math.PI * 1100 / sr);
    const y = new Float32Array(x.length);
    let lp = 0;
    for (let i = 0; i < x.length; i++) { lp += k * (x[i] - lp); y[i] = lp; }
    const W = Math.round(0.040 * sr), H = Math.round(0.020 * sr);
    // nadie que use esta app habla a 500 Hz: los niños llegan a ~400
    const tauMin = Math.floor(sr / 420), tauMax = Math.ceil(sr / 65);
    const vals = [], clar = [], energ = [];
    for (let start = 0; start + W + tauMax <= y.length; start += H) {
      let mu = 0;
      for (let i = 0; i < W + tauMax; i++) mu += y[start + i];
      mu /= (W + tauMax);
      let a0 = 0;
      for (let i = 0; i < W; i++) { const v = y[start + i] - mu; a0 += v * v; }
      if (a0 <= 0) continue;
      // YIN: diferencia media normalizada acumulada. Buscar el máximo de correlación
      // falla en las dos direcciones: daba octavas arriba (ruido de consonante) o
      // abajo (todo periodo múltiplo de una señal periódica correlaciona igual).
      // El primer mínimo suficientemente bueno SÍ es el periodo fundamental.
      const d = new Float64Array(tauMax + 2);
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let i = 0; i < W; i++) { const t = (y[start + i] - mu) - (y[start + i + tau] - mu); s += t * t; }
        d[tau] = s;
      }
      const dm = new Float64Array(tauMax + 2);
      let run = 0;
      for (let tau = 1; tau <= tauMax; tau++) {
        run += d[tau];
        dm[tau] = run > 1e-12 ? d[tau] * tau / run : 1;
      }
      let tau = 0;
      for (let t = tauMin; t <= tauMax - 1; t++) {
        if (dm[t] < 0.16 && dm[t] <= dm[t + 1]) { tau = t; break; }
      }
      if (!tau) { // sin mínimo claro: se toma el mejor de todos, pero con poca confianza
        let mejor = 1;
        for (let t = tauMin; t <= tauMax; t++) if (dm[t] < mejor) { mejor = dm[t]; tau = t; }
        if (tau && mejor > 0.55) tau = 0;
      }
      if (tau) {
        // La normalización acumulada del YIN corre el mínimo unas centésimas hacia
        // periodos cortos (~5% de tono de más). Se corrige buscando el mínimo de la
        // diferencia sin normalizar en la vecindad, y se interpola con una parábola.
        let tBest = tau;
        for (let t = Math.max(tauMin, tau - 3); t <= Math.min(tauMax, tau + 3); t++)
          if (d[t] < d[tBest]) tBest = t;
        const a = d[tBest - 1], b = d[tBest], c = d[tBest + 1];
        const den = a - 2 * b + c;
        const off = Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0;
        vals.push(sr / (tBest + Math.max(-0.5, Math.min(0.5, off))));
        clar.push(Math.max(0, 1 - dm[tau])); energ.push(a0);
      }
    }
    if (vals.length < 3) return { f0: 0, claridad: 0, voces: vals.length };
    // solo las ventanas con voz de verdad: la mediana de energías deja fuera los
    // silencios que el recorte no alcanzó a quitar
    const eOrd = energ.slice().sort((a, b) => a - b);
    const eMed = eOrd[Math.floor(eOrd.length / 2)];
    const filt = vals.filter((v, i) => energ[i] >= eMed * 0.35);
    const use = filt.length >= 3 ? filt : vals;
    use.sort((a, b) => a - b);
    const f0 = use[Math.floor(use.length / 2)];
    let c = 0; for (const v of clar) c += v;
    return { f0, claridad: c / clar.length, voces: use.length };
  }

  /* ---------------- API pública ---------------- */
  const Voz = {
    SR, NCOEF,
    pitch,
    /** huella de un AudioBuffer o Float32Array */
    huella(buffer, sampleRate) {
      const data = buffer instanceof Float32Array ? buffer : buffer.getChannelData(0);
      const sr = sampleRate || (buffer && buffer.sampleRate) || SR;
      const x = resampleTo16k(data, sr);
      return mfcc(x);
    },
    /** compara una huella contra una lista [{etiqueta, huella}] */
    comparar(huella, muestras) {
      const porEtiqueta = new Map();
      for (const m of muestras) {
        const d = dtw(huella, m.huella);
        const prev = porEtiqueta.get(m.etiqueta);
        // mediana y no mínimo: con el mínimo, una sola muestra mal grabada (una tos,
        // la tele de fondo) vuelve "reconocible" cualquier cosa que se le parezca.
        if (prev === undefined) porEtiqueta.set(m.etiqueta, [d]);
        else prev.push(d);
      }
      const orden = [...porEtiqueta.entries()].map(([etiqueta, ds]) => {
        const v = ds.filter(isFinite).sort((a, b) => a - b);
        return { etiqueta, distancia: v.length ? v[Math.floor(v.length / 2)] : Infinity, n: v.length };
      }).sort((a, b) => a.distancia - b.distancia);
      return orden;
    },
    /** umbral propio de cada palabra: mediana de las distancias entre sus propias
        muestras + 2 desviaciones. Un umbral único siempre queda mal para alguna:
        "sí" varía mucho más que "chocolate", y con el número global o se rechaza
        al niño o se acepta cualquier cosa. */
    umbrales(muestras, sens) {
      const por = new Map();
      for (const m of muestras) {
        if (!por.has(m.etiqueta)) por.set(m.etiqueta, []);
        por.get(m.etiqueta).push(m.huella);
      }
      const out = {};
      for (const [etiqueta, hs] of por) {
        const ds = [];
        for (let i = 0; i < hs.length; i++)
          for (let j = i + 1; j < hs.length; j++) {
            const d = dtw(hs[i], hs[j]);
            if (isFinite(d)) ds.push(d);
          }
        if (ds.length < 2) continue;
        ds.sort((a, b) => a - b);
        const med = ds[Math.floor(ds.length / 2)];
        let v = 0; for (const d of ds) v += (d - med) ** 2;
        const sd = Math.sqrt(v / ds.length);
        // calibrado en el banco: con 1.5+1.5 sd el mismo acierto pero acepta de más;
        // 1.3+1.0 sd no pierde ninguna palabra buena y aprieta lo justo
        out[etiqueta] = +Math.max(0.46, Math.min(0.60, med * 1.3 + 1.0 * sd)).toFixed(3);
      }
      return out;
    },
    packMFCC, unpackMFCC,
    dtw,
    _expandir: expandir,
    _mfcc: mfcc,
    _trim: trimSilence,
    _calcular: calcular
  };

  global.Voz = Voz;
})(typeof window !== 'undefined' ? window : globalThis);
