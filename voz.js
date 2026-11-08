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
    const thr = peak * 0.08;

    let a = 0, b = sm.length - 1;
    while (a < sm.length && sm[a] < thr) a++;
    while (b > a && sm[b] < thr) b--;
    if (a >= b) return x;

    const start = Math.max(0, a * win - 2 * win);
    const end = Math.min(x.length, (b + 1) * win + 2 * win);
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

  /* ---------------- DTW ---------------- */
  function dtw(a, b) {
    const n = a.length, m = b.length;
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
        let d = 0;
        const fa = a[i - 1], fb = b[j - 1];
        for (let k = 0; k < NCOEF; k++) { const t = fa[k] - fb[k]; d += t * t; }
        d = Math.sqrt(d);
        cur[j] = d + Math.min(prev[j], prev[j - 1], cur[j - 1]);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[m] / (n + m);
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

  /* ---------------- API pública ---------------- */
  const Voz = {
    SR, NCOEF,
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
        if (prev === undefined || d < prev) porEtiqueta.set(m.etiqueta, d);
      }
      const orden = [...porEtiqueta.entries()].sort((a, b) => a[1] - b[1]);
      return orden.map(([etiqueta, distancia]) => ({ etiqueta, distancia }));
    },
    packMFCC, unpackMFCC,
    dtw,
    _mfcc: mfcc,
    _trim: trimSilence,
    _calcular: calcular
  };

  global.Voz = Voz;
})(typeof window !== 'undefined' ? window : globalThis);
