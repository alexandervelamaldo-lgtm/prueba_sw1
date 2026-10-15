import { Router } from 'express';
import { z } from 'zod';
import { describeOperation, readDiagram } from '@app/shared';
import type { AssistantEngine, TurnoConAutor } from '../ai/assistant.js';
import type { IdentityProvider } from '../auth/identity.js';
import type { ProjectStore } from '../storage/store.js';
import type { RoomManager } from '../collab/rooms.js';
import { MAXIMO_TURNOS, type ChatMessage, type ConversationStore } from '../storage/conversaciones.js';
import { handler, parseBody, requireRole } from './http.js';

/**
 * Interpretación de órdenes del asistente (RF-IA-01, RF-IA-04).
 *
 * Devuelve una propuesta y no la aplica. Aplicarla es una segunda llamada
 * explícita a `/diagrama/operaciones`, hecha solo si el usuario acepta lo que ha
 * visto (decisión D6).
 *
 * Requiere permiso de edición aunque no escriba: proponer cambios a quien no
 * puede aplicarlos no tiene utilidad, y el resumen del diagrama que se envía al
 * modelo es información del proyecto.
 */

const PeticionSchema = z.object({
  texto: z.string().trim().min(1).max(2000),
});

/**
 * Cuántos nombres de otros proyectos se le cuentan a la IA.
 *
 * Es contexto de ambientación ("sabe que esta persona también lleva la
 * Tienda"), no un listado que haya que mantener completo: cinco nombres bastan
 * para eso y no hinchan el prompt de alguien con treinta proyectos.
 */
const MAXIMO_OTROS_PROYECTOS = 5;

/**
 * Resuelve `autorId → autorNombre` para un lote de turnos, igual que
 * `conNombres` en `api/tablon.ts`: el nombre no se guarda junto al mensaje,
 * se busca al leer, porque la identidad puede cambiar (o revocarse) después
 * de que el mensaje se escribiera. Los turnos del asistente tienen
 * `autorId: null` y no pasan por `identity.findById`.
 */
async function conAutores(turnos: ChatMessage[], identity: IdentityProvider): Promise<TurnoConAutor[]> {
  const nombres = new Map<string, string | null>();

  for (const turno of turnos) {
    if (turno.autorId === null || nombres.has(turno.autorId)) continue;
    const perfil = await identity.findById(turno.autorId);
    nombres.set(turno.autorId, perfil?.displayName ?? null);
  }

  return turnos.map((turno) => ({
    ...turno,
    autorNombre: turno.autorId === null ? null : nombres.get(turno.autorId) ?? null,
  }));
}

export function assistantRouter(deps: {
  store: ProjectStore;
  identity: IdentityProvider;
  rooms: RoomManager;
  assistant: AssistantEngine;
  conversations: ConversationStore;
}): Router {
  const { store, identity, rooms, assistant, conversations } = deps;
  const router = Router();

  router.post(
    '/:proyectoId/asistente',
    requireRole(store, 'editor'),
    handler(async (request, response) => {
      const body = parseBody(PeticionSchema, request.body);
      const proyectoId = request.params.proyectoId ?? '';
      const room = await rooms.open(proyectoId);
      const diagram = readDiagram(room.doc);

      // El historial es el hilo entero del proyecto, no uno por usuario (ver
      // `conversaciones.ts`): todos los integrantes leen y amplían la misma
      // conversación con la IA. De los otros proyectos solo se piden nombre y
      // rol —nunca se abre su sala (`rooms.open`)—, así que su diagrama no
      // llega a este prompt.
      const [turnos, misProyectos] = await Promise.all([
        conversations.getHistory(proyectoId, MAXIMO_TURNOS * 2),
        store.listProjectsForUser(request.user.id),
      ]);
      const historial = await conAutores(turnos, identity);
      const otrosProyectos = misProyectos
        .filter((proyecto) => proyecto.id !== proyectoId)
        .slice(0, MAXIMO_OTROS_PROYECTOS)
        .map((proyecto) => `${proyecto.name} (${proyecto.role})`);

      const result = await assistant.interpret(body.texto, diagram, { historial, otrosProyectos });
      await conversations.appendTurn(proyectoId, request.user.id, body.texto, result.explanation);

      response.json({
        motor: assistant.name,
        confianza: result.confidence,
        aclaracion: result.clarification,
        explicacion: result.explanation,
        // La descripción legible se calcula aquí y no la escribe el modelo: si
        // la escribiera él, podría describir algo distinto de lo que la
        // operación hace, y el usuario aprobaría lo que leyó, no lo que pasa.
        propuesta: result.operations.map((operation) => ({
          operacion: operation,
          descripcion: describeOperation(operation),
        })),
      });
    }),
  );

  router.get(
    '/:proyectoId/asistente/historial',
    requireRole(store, 'editor'),
    handler(async (request, response) => {
      const turnos = await conversations.getHistory(request.params.proyectoId ?? '', MAXIMO_TURNOS * 2);
      response.json({ turnos: await conAutores(turnos, identity) });
    }),
  );

  return router;
}
