import type { ChatMessage, ConversationStore } from '../storage/conversaciones.js';
import { resumenLocal, type AssistantEngine } from './assistant.js';
import type { CupoDeIA } from './cupo-ia.js';

/**
 * La memoria resumida del Modo IA: lo que sale de la ventana de 20 turnos del
 * proyecto se resume antes de perderse y el resumen vuelve como contexto.
 *
 * Lo usan las dos vías que podan el hilo: un turno nuevo (`api/assistant.ts`)
 * y un comentario espontáneo de la IA (`ai/vigilancia.ts`). Tiene que ser una
 * sola instancia para toda la app, porque la fila es lo que impide que dos
 * resúmenes del mismo proyecto partan del mismo resumen anterior y el segundo
 * en terminar borre lo que añadió el primero. La fila vive en este proceso,
 * que es el único que sirve la API.
 *
 * `usuarioId` es solo quién paga la llamada al modelo que genera el resumen
 * (su cupo diario, `ai/cupo-ia.ts`); el resumen en sí es del proyecto, no de
 * esa persona.
 *
 * El resumen se hace en segundo plano: quien preguntó no tiene por qué esperar
 * una llamada más al modelo para ver su respuesta, y si falla solo se pierde
 * el resumen de esos mensajes. Sin cupo no se llama al modelo: queda el
 * resumen local.
 */
export interface Resumidor {
  /** Encola el resumen de `salen` del proyecto, a cargo del cupo de `usuarioId`. No espera. */
  resumir(proyectoId: string, usuarioId: string, salen: ChatMessage[]): void;
}

export function crearResumidor(deps: {
  conversations: ConversationStore;
  assistant: AssistantEngine;
  cupo: CupoDeIA;
}): Resumidor & {
  /** Espera a que termine lo encolado en ese proyecto. Solo lo usan las pruebas. */
  esperar(proyectoId: string): Promise<void>;
} {
  const { conversations, assistant, cupo } = deps;
  const fila = new Map<string, Promise<void>>();

  return {
    resumir(proyectoId, usuarioId, salen) {
      if (salen.length === 0) return;
      const siguiente = (fila.get(proyectoId) ?? Promise.resolve()).then(async () => {
        try {
          const previo = await conversations.getResumen(proyectoId);
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
          await conversations.setResumen(proyectoId, nuevo);
        } catch (error) {
          console.warn('No se pudo actualizar el resumen de la conversación:', (error as Error).message);
        }
      });
      fila.set(proyectoId, siguiente);
      void siguiente.then(() => {
        if (fila.get(proyectoId) === siguiente) fila.delete(proyectoId);
      });
    },
    async esperar(proyectoId) {
      await fila.get(proyectoId);
    },
  };
}
