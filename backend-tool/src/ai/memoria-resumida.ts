import type { ChatMessage, ConversationStore } from '../storage/conversaciones.js';
import { resumenLocal, type AssistantEngine } from './assistant.js';
import type { CupoDeIA } from './cupo-ia.js';

/**
 * La memoria resumida del Modo IA: lo que sale de la ventana de 20 turnos de
 * un hilo se resume antes de perderse y el resumen vuelve como contexto.
 *
 * Lo usan las dos vías que podan un hilo: un turno nuevo (`api/assistant.ts`)
 * y un comentario espontáneo de la IA (`ai/vigilancia.ts`). Tiene que ser una
 * sola instancia para toda la app, porque la fila es lo que impide que dos
 * resúmenes del mismo hilo partan del mismo resumen anterior y el segundo en
 * terminar borre lo que añadió el primero. La fila vive en este proceso, que
 * es el único que sirve la API.
 *
 * El resumen se hace en segundo plano: quien preguntó no tiene por qué esperar
 * una llamada más al modelo para ver su respuesta, y si falla solo se pierde
 * el resumen de esos mensajes. Sin cupo no se llama al modelo: queda el
 * resumen local.
 */
export interface Resumidor {
  /** Encola el resumen de `salen` en el hilo `(proyecto, usuario)`. No espera. */
  resumir(proyectoId: string, usuarioId: string, salen: ChatMessage[]): void;
}

export function crearResumidor(deps: {
  conversations: ConversationStore;
  assistant: AssistantEngine;
  cupo: CupoDeIA;
}): Resumidor & {
  /** Espera a que termine lo encolado en ese hilo. Solo lo usan las pruebas. */
  esperar(proyectoId: string, usuarioId: string): Promise<void>;
} {
  const { conversations, assistant, cupo } = deps;
  const fila = new Map<string, Promise<void>>();
  const clave = (proyectoId: string, usuarioId: string): string => `${proyectoId}\u0000${usuarioId}`;

  return {
    resumir(proyectoId, usuarioId, salen) {
      if (salen.length === 0) return;
      const k = clave(proyectoId, usuarioId);
      const siguiente = (fila.get(k) ?? Promise.resolve()).then(async () => {
        try {
          const previo = await conversations.getResumen(proyectoId, usuarioId);
          const reserva = assistant.resumirConversacion ? await cupo.reservar(usuarioId) : null;
          let nuevo: string;
          try {
            nuevo =
              reserva && assistant.resumirConversacion
                ? await assistant.resumirConversacion(previo, salen, reserva.registrar)
                : resumenLocal(previo, salen);
          } finally {
            await reserva?.cerrar();
          }
          await conversations.setResumen(proyectoId, usuarioId, nuevo);
        } catch (error) {
          console.warn('No se pudo actualizar el resumen de la conversación:', (error as Error).message);
        }
      });
      fila.set(k, siguiente);
      void siguiente.then(() => {
        if (fila.get(k) === siguiente) fila.delete(k);
      });
    },
    async esperar(proyectoId, usuarioId) {
      await fila.get(clave(proyectoId, usuarioId));
    },
  };
}
