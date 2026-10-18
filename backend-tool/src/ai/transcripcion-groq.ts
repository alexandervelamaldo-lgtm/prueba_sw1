import { ErrorDeVoz } from './voz-elevenlabs.js';

/**
 * Transcripción de voz con Groq (Whisper), para los navegadores que no traen
 * reconocimiento de voz propio, como Firefox: el navegador graba, el servidor
 * transcribe y el texto sigue el camino de siempre hacia la IA.
 *
 * Opcional. Sin `GROQ_API_KEY` no se crea, y esos navegadores siguen sin
 * micrófono, como antes. La clave vive solo aquí. Groq habla el protocolo de
 * OpenAI (`/openai/v1/audio/transcriptions`) y acepta el `webm`/`ogg` que
 * graba el navegador, así que no hay que convertir nada.
 */

export interface TranscriptorDeVoz {
  transcribir(audio: Buffer, tipo: string): Promise<string>;
}

/** El más rápido y barato de Groq; con buen castellano. */
export const MODELO_TRANSCRIPCION_POR_DEFECTO = 'whisper-large-v3-turbo';

/** Extensión que se le da al fichero según su tipo: Groq decide el formato por ella. */
function extensionDe(tipo: string): string {
  if (tipo.includes('ogg')) return 'ogg';
  if (tipo.includes('mp4') || tipo.includes('m4a')) return 'm4a';
  if (tipo.includes('mpeg') || tipo.includes('mp3')) return 'mp3';
  if (tipo.includes('wav')) return 'wav';
  return 'webm';
}

export function crearTranscriptorGroq(opciones: {
  apiKey: string;
  modelo?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): TranscriptorDeVoz {
  const base = (opciones.baseUrl ?? 'https://api.groq.com').replace(/\/+$/, '');
  const modelo = opciones.modelo ?? MODELO_TRANSCRIPCION_POR_DEFECTO;

  return {
    async transcribir(audio, tipo) {
      const formulario = new FormData();
      formulario.append('file', new Blob([audio], { type: tipo }), `voz.${extensionDe(tipo)}`);
      formulario.append('model', modelo);
      formulario.append('language', 'es');
      formulario.append('response_format', 'json');

      const controlador = new AbortController();
      const plazo = setTimeout(() => controlador.abort(), opciones.timeoutMs ?? 20_000);
      try {
        const respuesta = await fetch(`${base}/openai/v1/audio/transcriptions`, {
          method: 'POST',
          signal: controlador.signal,
          headers: { authorization: `Bearer ${opciones.apiKey}` },
          body: formulario,
        });
        if (!respuesta.ok) {
          // El cuerpo del error no se guarda en el mensaje: acaba en los registros.
          await respuesta.body?.cancel().catch(() => {});
          throw new ErrorDeVoz(`Groq respondió ${respuesta.status}`, respuesta.status);
        }
        const datos = (await respuesta.json()) as { text?: unknown };
        return typeof datos.text === 'string' ? datos.text.trim() : '';
      } catch (error) {
        if (error instanceof ErrorDeVoz) throw error;
        if (error instanceof Error && error.name === 'AbortError') throw new ErrorDeVoz('Groq no respondió a tiempo');
        throw new ErrorDeVoz(`No se pudo llamar a Groq: ${(error as Error).message}`);
      } finally {
        clearTimeout(plazo);
      }
    },
  };
}
