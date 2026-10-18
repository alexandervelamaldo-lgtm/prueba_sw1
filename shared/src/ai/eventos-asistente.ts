import type { Operation } from '../ops/operations.js';

/**
 * Lo que el servidor le va mandando al Modo IA mientras el modelo escribe
 * (`POST /:proyectoId/asistente/stream`), como Server-Sent Events.
 *
 * El modelo responde con una lista de acciones (ver `parseAssistantResponse`);
 * el servidor la lee a medida que llega y reenvía cada acción en cuanto está
 * completa, para que el navegador pueda hablar y aplicar sin esperar al final.
 *
 * - `mensaje-parcial`: el texto, todavía incompleto, del mensaje que el modelo
 *   está escribiendo ahora. Cada uno sustituye al anterior; sirve para pintar
 *   el texto mientras se escribe.
 * - `mensaje`: un mensaje ya completo. Es lo que se habla.
 * - `operacion`: una operación completa y validada, con su descripción legible
 *   calculada en el servidor (nunca la escribe el modelo).
 * - `senalar`: la IA señala esas clases del lienzo, por nombre, sin cambiarlas.
 * - `fin`: el modelo terminó. Siempre es el último evento de una respuesta sana.
 * - `error`: algo falló a mitad. Lo ya enviado sigue valiendo; no llega `fin`.
 *
 * El razonamiento interno del modelo (`think`) no se envía.
 */
export type EventoAsistente =
  | { tipo: 'mensaje-parcial'; texto: string }
  | { tipo: 'mensaje'; texto: string }
  | { tipo: 'operacion'; operacion: Operation; descripcion: string }
  | { tipo: 'senalar'; clases: string[] }
  | { tipo: 'fin'; motor: string; confianza: number }
  | { tipo: 'error'; mensaje: string };

const TIPOS = new Set<EventoAsistente['tipo']>([
  'mensaje-parcial',
  'mensaje',
  'operacion',
  'senalar',
  'fin',
  'error',
]);

/** Un evento como bloque SSE: una sola línea `data` (JSON no lleva saltos de línea sin escapar). */
export function formatearEventoSse(evento: EventoAsistente): string {
  return `data: ${JSON.stringify(evento)}\n\n`;
}

/**
 * Lector incremental de SSE para el navegador: se le empujan los trozos tal
 * como llegan por la red, cortados por cualquier sitio, y avisa de cada evento
 * completo. Ignora comentarios (`: ...`) y lo que no sea un evento conocido.
 */
export function crearLectorSse(alEvento: (evento: EventoAsistente) => void): { empujar(trozo: string): void } {
  let pendiente = '';

  const procesarBloque = (bloque: string): void => {
    const datos = bloque
      .split('\n')
      .filter((linea) => linea.startsWith('data:'))
      .map((linea) => linea.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!datos) return;
    let evento: unknown;
    try {
      evento = JSON.parse(datos);
    } catch {
      return;
    }
    if (typeof evento === 'object' && evento !== null && TIPOS.has((evento as { tipo: never }).tipo)) {
      alEvento(evento as EventoAsistente);
    }
  };

  return {
    empujar(trozo) {
      pendiente += trozo.replace(/\r\n/g, '\n');
      let corte = pendiente.indexOf('\n\n');
      while (corte !== -1) {
        procesarBloque(pendiente.slice(0, corte));
        pendiente = pendiente.slice(corte + 2);
        corte = pendiente.indexOf('\n\n');
      }
    },
  };
}
