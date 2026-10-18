/**
 * La voz de ElevenLabs para el Modo IA: convierte el texto de la IA en audio.
 *
 * Opcional. Sin `ELEVENLABS_API_KEY` no se crea, y el navegador habla con su
 * propia voz como siempre. La clave vive solo aquí, en el servidor: el
 * navegador pide el audio a `POST /api/voz/sintetizar` y nunca la ve.
 *
 * El plan gratuito de ElevenLabs (10 000 créditos al mes, uso no comercial
 * con mención a ElevenLabs) rinde más con `eleven_flash_v2_5`, que cuesta la
 * mitad por carácter y habla castellano. Cuando se acaban los créditos, el
 * proveedor responde con un error y la ruta avisa al navegador para que use
 * su voz.
 */

export class ErrorDeVoz extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ErrorDeVoz';
  }
}

export interface SintetizadorDeVoz {
  sintetizar(texto: string, signal?: AbortSignal): Promise<{ datos: ArrayBuffer; tipo: string }>;
}

/** Una de las voces prediseñadas de ElevenLabs; se cambia con `ELEVENLABS_VOICE_ID`. */
export const VOZ_POR_DEFECTO = 'JBFqnCBsd6RMkjVDRZzb';
export const MODELO_POR_DEFECTO = 'eleven_flash_v2_5';

export function crearVozElevenLabs(opciones: {
  apiKey: string;
  voiceId?: string;
  modelo?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): SintetizadorDeVoz {
  const base = (opciones.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const voz = opciones.voiceId ?? VOZ_POR_DEFECTO;
  const modelo = opciones.modelo ?? MODELO_POR_DEFECTO;

  return {
    async sintetizar(texto, signal) {
      const controlador = new AbortController();
      const plazo = setTimeout(() => controlador.abort(), opciones.timeoutMs ?? 15_000);
      const abortar = (): void => controlador.abort();
      signal?.addEventListener('abort', abortar, { once: true });
      try {
        const respuesta = await fetch(
          `${base}/v1/text-to-speech/${encodeURIComponent(voz)}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            signal: controlador.signal,
            headers: { 'content-type': 'application/json', 'xi-api-key': opciones.apiKey, accept: 'audio/mpeg' },
            body: JSON.stringify({ text: texto, model_id: modelo }),
          },
        );
        if (!respuesta.ok) {
          // El cuerpo del error no se guarda en el mensaje: acaba en los registros.
          await respuesta.body?.cancel().catch(() => {});
          throw new ErrorDeVoz(`ElevenLabs respondió ${respuesta.status}`, respuesta.status);
        }
        return { datos: await respuesta.arrayBuffer(), tipo: respuesta.headers.get('content-type') ?? 'audio/mpeg' };
      } catch (error) {
        if (error instanceof ErrorDeVoz) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          throw new ErrorDeVoz('ElevenLabs no respondió a tiempo');
        }
        throw new ErrorDeVoz(`No se pudo llamar a ElevenLabs: ${(error as Error).message}`);
      } finally {
        clearTimeout(plazo);
        signal?.removeEventListener('abort', abortar);
      }
    },
  };
}
