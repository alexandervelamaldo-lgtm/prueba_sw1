import { Router } from 'express';
import { z } from 'zod';
import * as Y from 'yjs';
import { initializeDiagram, readDiagram } from '@app/shared';
import type { ProjectStore } from '../storage/store.js';
import type { RoomManager } from '../collab/rooms.js';
import type { VersionResumen, VersionStore } from '../storage/versiones.js';
import { handler, notFound, parseBody, requireRole } from './http.js';

/**
 * Puntos de control del proyecto: crear uno, listarlos y volver a uno de ellos.
 *
 * «Restaurar» no aplica los bytes Yjs guardados directamente sobre el
 * documento en vivo: aplicarlos fusionaría el pasado con el presente en vez de
 * volver a él. En su lugar se decodifican en un documento aparte, se leen como
 * un `ClassDiagram` y se vuelcan con `initializeDiagram`, el mismo reemplazo
 * completo que ya usa `PUT /:proyectoId/diagrama`. Por eso esta ruta exige
 * `owner`: igual que ese `PUT`, destruye el trabajo sin guardar de los demás.
 */

const CrearVersionSchema = z.object({
  mensaje: z.string().trim().min(1).max(200),
});

export function versionesRouter(deps: {
  store: ProjectStore;
  rooms: RoomManager;
  versiones: VersionStore;
}): Router {
  const { store, rooms, versiones } = deps;
  const router = Router();

  router.get(
    '/:proyectoId/versiones',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      response.json({ versiones: await versiones.listar(request.params.proyectoId ?? '') });
    }),
  );

  router.post(
    '/:proyectoId/versiones',
    requireRole(store, 'editor'),
    handler(async (request, response) => {
      const body = parseBody(CrearVersionSchema, request.body);
      const proyectoId = request.params.proyectoId ?? '';
      const room = await rooms.open(proyectoId);
      const version = await versiones.crear({
        proyectoId,
        estado: Y.encodeStateAsUpdate(room.doc),
        mensaje: body.mensaje,
        autorId: request.user.id,
      });
      response.status(201).json({ version });
    }),
  );

  router.get(
    '/:proyectoId/versiones/:versionId',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const proyectoId = request.params.proyectoId ?? '';
      const version = await versiones.obtener(proyectoId, request.params.versionId ?? '');
      if (!version) throw notFound('La versión no existe');

      // Mismo documento de usar y tirar que `restaurar`, pero sin el segundo
      // paso: aquí solo se quiere leer el diagrama de esa versión para poder
      // compararlo con el actual, no sustituir nada. Por eso basta `viewer` y
      // no se toca `rooms` ni se llama a `room.save()`.
      const docDeLaVersion = new Y.Doc();
      Y.applyUpdate(docDeLaVersion, version.estado);
      const diagrama = readDiagram(docDeLaVersion);

      const resumen: VersionResumen = {
        id: version.id,
        proyectoId: version.proyectoId,
        mensaje: version.mensaje,
        autorId: version.autorId,
        creadoEn: version.creadoEn,
      };
      response.json({ version: resumen, diagrama });
    }),
  );

  router.post(
    '/:proyectoId/versiones/:versionId/restaurar',
    requireRole(store, 'owner'),
    handler(async (request, response) => {
      const proyectoId = request.params.proyectoId ?? '';
      const version = await versiones.obtener(proyectoId, request.params.versionId ?? '');
      if (!version) throw notFound('La versión no existe');

      // Documento de usar y tirar, solo para leer el diagrama que describía el
      // estado guardado; no se persiste ni se comparte.
      const docDeLaVersion = new Y.Doc();
      Y.applyUpdate(docDeLaVersion, version.estado);
      const diagram = readDiagram(docDeLaVersion);

      const room = await rooms.open(proyectoId);
      initializeDiagram(room.doc, diagram);
      await room.save();

      response.json({ diagrama: readDiagram(room.doc) });
    }),
  );

  return router;
}
