# AutoLeo

Traductor de Leonardo. Escucha las pocas palabras que dice y las dice completas en voz alta, en español mexicano, con la frase enorme en pantalla.

## Cómo se usa

1. Abre la app en el teléfono (Chrome en Android).
2. Menú del navegador → **Agregar a la pantalla de inicio**. Queda como app y abre sin internet.
3. Toca **⚙️** y agrega una palabra: qué significa, cómo la dice él y un emoji.
4. Toca **grabar** y deja que la diga. Cinco veces por palabra.
5. En la pantalla principal, **🎤 Escuchar**: si la reconoce, dice la frase completa; si no, contesta "No te entendí".

## Cómo reconoce

Sin internet y sin cuentas. El audio se convierte en una huella de 13 números cada 10 milisegundos (MFCC), se normaliza para que no importen el volumen ni el micrófono, y se compara con las muestras grabadas alineando el tiempo (DTW).

- El umbral de decisión se calcula solo, a partir de las distancias entre sus propias grabaciones.
- Perilla **Estricto / Normal / Tolerante** para el adulto.
- Si dos palabras quedan casi empatadas y ninguna se parece a lo grabado, contesta "No te entendí" en vez de adivinar.

**Ningún audio sale del teléfono.** Todo se guarda primero en el navegador y la app funciona sin internet. Como respaldo se suben a Supabase solo el texto de las palabras y una huella numérica (MFCC, ~1 KB) de cada muestra, nunca el audio. En Ajustes hay **Guardar copia** y **Restaurar copia** para mover todo a otro teléfono con un archivo.

## Archivos

- `index.html` — pantalla única: botón de escuchar, frase grande, historial y ajustes.
- `voz.js` — motor de audio: MFCC y DTW, sin dependencias.
- `escuchar.js` — micrófono, muestras, umbral, traducción y modo manos libres.
- `sw.js` — caché para abrir sin red (navegación primero en red, luego caché).
- `manifest.webmanifest`, `icon-192.png`, `icon-512.png` — instalación como app.
