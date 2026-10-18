import { Router } from 'express';
import { z } from 'zod';
import * as Y from 'yjs';
import {
  ClassDiagramSchema,
  OperationSchema,
  applyOperations,
  initializeDiagram,
  readDiagram,
} from '@app/shared';
import type { ProjectStore } from '../storage/store.js';
import type { RoomManager } from '../collab/rooms.js';
import { badRequest, handler, parseBody, requireRole } from './http.js';

/**
 * Acceso al diagrama por HTTP.
 *
 * El camino normal de edición es el WebSocket; estas rutas cubren lo que aquel
 * no puede: leer el diagrama sin abrir una sesión colaborativa (lo hace el
 * generador y lo hará Architech), y reconciliar un cliente que estuvo offline y
 * no puede mantener el socket abierto el tiempo suficiente (RF-OFF-04).
 *
 * El estado se intercambia como actualización Yjs en base64, no como JSON. Un
 * JSON obligaría a reemplazar el documento y eso destruiría lo que otros hayan
 * hecho mientras tanto; una actualización Yjs se *fusiona*, que es justamente
 * la propiedad por la que se eligió un CRDT (decisión D1).
 */

const EstadoSchema = z.object({
  /** Actualización Yjs codificada en base64. */
  actualizacion: z.string().min(1),
  /**
   * Vector de estado del cliente, en base64.
   *
   * Es lo que permite responder con lo que le falta. Sin él hay que devolver el
   * documento entero: el servidor no puede deducir qué conoce el cliente a
   * partir de la actualización que acaba de recibir, porque esa actualización
   * describe lo que el cliente *hizo*, no lo que *tiene*.
   */
  vectorEstado: z.string().optional(),
});

const OperacionesSchema = z.object({
  operaciones: z.array(OperationSchema).min(1).max(200),
});

function decodeUpdate(base64: string): Uint8Array {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) throw badRequest('La actualización está vacía', 'ACTUALIZACION_VACIA');
  return new Uint8Array(buffer);
}

export function diagramsRouter(deps: { store: ProjectStore; rooms: RoomManager }): Router {
  const { store, rooms } = deps;
  const router = Router();

  router.get(
    '/:proyectoId/diagrama',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const room = await rooms.open(request.params.proyectoId ?? '');
      response.json({ diagrama: readDiagram(room.doc) });
    }),
  );

  /**
   * Devuelve lo que al cliente le falta.
   *
   * Si envía su vector de estado, la respuesta contiene solo la diferencia; sin
   * él, el documento entero. Es la misma negociación que hace el WebSocket, en
   * una sola petición.
   */
  router.get(
    '/:proyectoId/diagrama/estado',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const room = await rooms.open(request.params.proyectoId ?? '');
      const since = request.query.desde;

      let update: Uint8Array;
      if (typeof since === 'string' && since.length > 0) {
        update = Y.encodeStateAsUpdate(room.doc, new Uint8Array(Buffer.from(since, 'base64')));
      } else {
        update = Y.encodeStateAsUpdate(room.doc);
      }

      response.json({
        actualizacion: Buffer.from(update).toString('base64'),
        vectorEstado: Buffer.from(Y.encodeStateVector(room.doc)).toString('base64'),
      });
    }),
  );

  /** Fusiona el trabajo hecho offline y responde con lo que el cliente no tiene. */
  router.post(
    '/:proyectoId/diagrama/estado',
    requireRole(store, 'editor'),
    handler(async (request, response) => {
      const body = parseBody(EstadoSchema, request.body);
      const room = await rooms.open(request.params.proyectoId ?? '');

      try {
        Y.applyUpdate(room.doc, decodeUpdate(body.actualizacion), 'sincronizacion-http');
      } catch {
        throw badRequest('La actualización no es un documento Yjs válido', 'ACTUALIZACION_ILEGIBLE');
      }

      await room.save();

      // La diferencia se calcula contra el vector del *cliente*, no contra el
      // que el servidor tenía antes de fusionar. Con el del servidor la
      // respuesta sería el propio cambio del cliente devuelto como un eco,
      // mientras que lo que otros hicieron mientras estaba offline —justo lo
      // que necesita— quedaría fuera por ser anterior a la fusión.
      const update = body.vectorEstado
        ? Y.encodeStateAsUpdate(room.doc, new Uint8Array(Buffer.from(body.vectorEstado, 'base64')))
        : Y.encodeStateAsUpdate(room.doc);

      response.json({
        actualizacion: Buffer.from(update).toString('base64'),
        vectorEstado: Buffer.from(Y.encodeStateVector(room.doc)).toString('base64'),
      });
    }),
  );

  /**
   * Aplica operaciones de dominio. Es el camino que usa el asistente cuando el
   * usuario acepta una propuesta desde un cliente sin sesión colaborativa
   * abierta; la lógica es la misma que en el navegador porque vive en `shared`.
   */
  router.post(
    '/:proyectoId/diagrama/operaciones',
    requireRole(store, 'editor'),
    handler(async (request, response) => {
      const body = parseBody(OperacionesSchema, request.body);
      const room = await rooms.open(request.params.proyectoId ?? '');
      const result = applyOperations(room.doc, body.operaciones, {
        // Con el usuario en el origen, `ai/vigilancia.ts` sabe a qué hilo
        // dirigir un comentario sobre este cambio.
        origin: { via: 'api', userId: request.user.id },
      });

      if (!result.ok) {
        response.status(422).json({
          error: result.error,
          code: 'OPERACION_NO_APLICABLE',
          operacion: result.failedAt,
        });
        return;
      }

      await room.save();
      response.json({
        aplicadas: result.results.length,
        descripciones: result.results.map((r) => (r.ok ? r.description : '')),
        diagrama: readDiagram(room.doc),
      });
    }),
  );

  /**
   * Reemplaza el diagrama entero. Restringido al propietario: al contrario que
   * las demás rutas, esta sí destruye el trabajo de los otros participantes.
   */
  router.put(
    '/:proyectoId/diagrama',
    requireRole(store, 'owner'),
    handler(async (request, response) => {
      const diagram = parseBody(ClassDiagramSchema, request.body);
      const room = await rooms.open(request.params.proyectoId ?? '');
      initializeDiagram(room.doc, diagram);
      await room.save();
      response.json({ diagrama: readDiagram(room.doc) });
    }),
  );

  return router;
}
