/**
 * La voz del servidor (ElevenLabs) en el navegador: pide el audio de una
 * frase a `POST /api/voz/sintetizar` y lo reproduce. `voz.ts` la usa en
 * `hablar` y `callar` cuando el servidor dice que la tiene; si no, todo sigue
 * con la voz del navegador como siempre.
 *
 * Un fallo nunca deja a la IA muda: cae a la voz del navegador (`alFallar`).
 * Si el servidor responde 503 —no hay voz configurada o se acabaron los
 * créditos—, deja de intentarlo el resto de la sesión, para no hacer esperar
 * cada frase a un pedido que va a fallar.
 *
 * Las dependencias llegan inyectadas para probarlo sin red ni `Audio`.
 */

export interface ReproductorAudio {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface DependenciasVozServidor {
  pedirAudio(texto: string, senal: AbortSignal): Promise<Blob>;
  crearReproductor(url: string): ReproductorAudio;
  crearUrl(audio: Blob): string;
  liberarUrl(url: string): void;
}

export interface VozDelServidor {
  /** `false` si el servidor no tiene voz o dejó de tenerla en esta sesión. */
  readonly activa: boolean;
  hablar(texto: string, alTerminar: (() => void) | undefined, alFallar: () => void): void;
  callar(): void;
}

export function crearVozDelServidor(deps: DependenciasVozServidor): VozDelServidor {
  let activa = true;
  // Cada `hablar` o `callar` invalida lo anterior: un audio que llega tarde,
  // o un final que dispara la pausa, no habla ni avisa por encima del nuevo.
  let generacion = 0;
  let enCurso: { reproductor: ReproductorAudio | null; url: string | null; pedido: AbortController } | null = null;

  const soltar = (): void => {
    if (!enCurso) return;
    enCurso.pedido.abort();
    if (enCurso.reproductor) {
      enCurso.reproductor.onended = null;
      enCurso.reproductor.onerror = null;
      enCurso.reproductor.pause();
    }
    if (enCurso.url) deps.liberarUrl(enCurso.url);
    enCurso = null;
  };

  return {
    get activa() {
      return activa;
    },

    hablar(texto, alTerminar, alFallar) {
      soltar();
      generacion += 1;
      const mia = generacion;
      const actual: NonNullable<typeof enCurso> = { reproductor: null, url: null, pedido: new AbortController() };
      enCurso = actual;

      const fallar = (error?: unknown): void => {
        if (mia !== generacion) return;
        if ((error as { status?: number } | undefined)?.status === 503) activa = false;
        soltar();
        alFallar();
      };

      void deps
        .pedirAudio(texto, actual.pedido.signal)
        .then(async (audio) => {
          if (mia !== generacion) return;
          actual.url = deps.crearUrl(audio);
          const reproductor = deps.crearReproductor(actual.url);
          actual.reproductor = reproductor;
          reproductor.onended = () => {
            if (mia !== generacion) return;
            soltar();
            alTerminar?.();
          };
          reproductor.onerror = () => fallar();
          await reproductor.play();
        })
        .catch(fallar);
    },

    callar() {
      generacion += 1;
      soltar();
    },
  };
}
