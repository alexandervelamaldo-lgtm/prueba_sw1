/**
 * Dictado en los navegadores sin reconocimiento de voz propio, como Firefox:
 * se graba el micrófono (`MediaRecorder`, que Firefox sí tiene), se detecta
 * cuándo terminó de hablar la persona por el nivel del audio y se manda la
 * grabación al servidor, que la transcribe con Groq (`POST /api/voz/transcribir`).
 *
 * `voz.ts` lo usa solo cuando el navegador no trae `SpeechRecognition` y el
 * servidor dice que tiene transcripción. A diferencia del dictado nativo, no
 * hay texto parcial mientras se habla: llega todo junto al hacer la pausa.
 */

export type DecisionDeGrabacion = 'seguir' | 'terminar' | 'sin-voz';

/**
 * Cuándo dejar de grabar, muestra a muestra. La pausa para dar por terminada
 * la orden es más corta que la del dictado nativo (6 s): allí se ve el texto
 * mientras se habla y esperar no molesta; aquí no se ve nada hasta mandar, y
 * seis segundos de silencio se harían eternos.
 */
export function crearDetectorDeSilencio(opciones: {
  /** Nivel (RMS de 0 a 1) a partir del cual se considera voz. */
  umbral: number;
  msSilencioTrasHablar: number;
  msEsperaSinVoz: number;
  msMaximo: number;
}): { muestra(nivel: number, ahora: number): DecisionDeGrabacion } {
  let inicio: number | null = null;
  let ultimaVoz: number | null = null;

  return {
    muestra(nivel, ahora) {
      inicio ??= ahora;
      if (nivel >= opciones.umbral) ultimaVoz = ahora;
      if (ahora - inicio >= opciones.msMaximo) return ultimaVoz === null ? 'sin-voz' : 'terminar';
      if (ultimaVoz === null) return ahora - inicio >= opciones.msEsperaSinVoz ? 'sin-voz' : 'seguir';
      return ahora - ultimaVoz >= opciones.msSilencioTrasHablar ? 'terminar' : 'seguir';
    },
  };
}

export const TIEMPOS_GRABACION = {
  umbral: 0.02,
  msSilencioTrasHablar: 1500,
  msEsperaSinVoz: 15_000,
  msMaximo: 30_000,
};

/** Cada cuánto se mira el nivel del micrófono. */
const MS_ENTRE_MUESTRAS = 100;

export interface OyentesGrabacion {
  /** Aquí solo dice «Transcribiendo…» mientras espera al servidor; no hay texto parcial. */
  onParcial?: (texto: string) => void;
  onFinal: (texto: string) => void;
  onError: (mensaje: string) => void;
  onFin: () => void;
}

/** Si el navegador puede grabar el micrófono (no si el servidor puede transcribir). */
export function grabacionDisponible(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined'
  );
}

/** El primer formato que el navegador sabe grabar y Groq sabe leer. */
function formatoDeGrabacion(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg'].find((tipo) =>
    MediaRecorder.isTypeSupported(tipo),
  );
}

/**
 * Graba hasta la pausa y entrega el texto transcrito. `detener` corta la
 * grabación y transcribe lo que se haya dicho hasta ahí, como el botón de
 * parar del dictado nativo. `cancelar` (al cerrar el panel) corta sin mandar
 * nada. Pase lo que pase —fin, error o cancelación—, el micrófono se cierra.
 */
export function dictarGrabando(
  oyentes: OyentesGrabacion,
  transcribir: (audio: Blob) => Promise<string>,
): { detener: () => void; cancelar: () => void } {
  let detenido = false;
  let cancelado = false;
  let terminar: (() => void) | null = null;

  void (async () => {
    let flujo: MediaStream | null = null;
    let contexto: AudioContext | null = null;
    let reloj: ReturnType<typeof setInterval> | null = null;
    const limpiar = (): void => {
      if (reloj) clearInterval(reloj);
      flujo?.getTracks().forEach((pista) => pista.stop());
      void contexto?.close().catch(() => {});
    };

    try {
      flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const nombre = (error as { name?: string }).name;
      oyentes.onError(
        nombre === 'NotAllowedError' ? 'No se ha dado permiso para usar el micrófono.' : 'No se encuentra ningún micrófono.',
      );
      oyentes.onFin();
      return;
    }
    if (detenido) {
      limpiar();
      oyentes.onFin();
      return;
    }

    // Desde aquí el micrófono está abierto: cualquier fallo al preparar la
    // grabación tiene que cerrarlo antes de avisar.
    try {
      const tipo = formatoDeGrabacion();
      const grabadora = new MediaRecorder(flujo, tipo ? { mimeType: tipo } : undefined);
      const trozos: Blob[] = [];
      grabadora.ondataavailable = (evento) => {
        if (evento.data.size > 0) trozos.push(evento.data);
      };
      let huboVoz = true;
      grabadora.onstop = () => {
        limpiar();
        if (cancelado || !huboVoz || trozos.length === 0) {
          oyentes.onFin();
          return;
        }
        const audio = new Blob(trozos, { type: grabadora.mimeType || tipo || 'audio/webm' });
        oyentes.onParcial?.('Transcribiendo…');
        transcribir(audio)
          .then((texto) => {
            if (texto.trim()) oyentes.onFinal(texto.trim());
            else oyentes.onParcial?.('');
          })
          .catch((error: unknown) => {
            oyentes.onParcial?.('');
            oyentes.onError(error instanceof Error ? error.message : 'No se pudo transcribir la voz.');
          })
          .finally(() => oyentes.onFin());
      };

      // El nivel del micrófono, para saber cuándo terminó de hablar.
      contexto = new AudioContext();
      const analizador = contexto.createAnalyser();
      analizador.fftSize = 1024;
      contexto.createMediaStreamSource(flujo).connect(analizador);
      const muestras = new Float32Array(analizador.fftSize);
      const detector = crearDetectorDeSilencio(TIEMPOS_GRABACION);

      terminar = () => {
        if (grabadora.state !== 'inactive') grabadora.stop();
      };
      grabadora.start();
      reloj = setInterval(() => {
        analizador.getFloatTimeDomainData(muestras);
        let suma = 0;
        for (const valor of muestras) suma += valor * valor;
        const decision = detector.muestra(Math.sqrt(suma / muestras.length), performance.now());
        if (decision === 'seguir') return;
        huboVoz = decision === 'terminar';
        terminar?.();
      }, MS_ENTRE_MUESTRAS);
    } catch {
      limpiar();
      oyentes.onError('No se pudo iniciar el micrófono.');
      oyentes.onFin();
    }
  })();

  return {
    detener() {
      detenido = true;
      terminar?.();
    },
    cancelar() {
      cancelado = true;
      detenido = true;
      terminar?.();
    },
  };
}
