import { Router } from 'express';
import { z } from 'zod';
import { initializeEmpty, toKebabCase } from '@app/shared';
import type { IdentityProvider } from '../auth/identity.js';
import type { ProjectStore } from '../storage/store.js';
import type { RoomManager } from '../collab/rooms.js';
import type { TablonStore } from '../storage/tablon.js';
import type { ConversationStore } from '../storage/conversaciones.js';
import type { VersionStore } from '../storage/versiones.js';
import { badRequest, handler, notFound, parseBody, requireRole } from './http.js';

/**
 * Gestión de proyectos y de sus miembros (RF-COL-01, RF-COL-02).
 *
 * Los metadatos viven aquí y el contenido del diagrama en el documento CRDT.
 * Son dos ciclos de vida distintos —el nombre cambia una vez, el diagrama en
 * cada pulsación— y mezclarlos obligaría a reescribir el documento entero cada
 * vez que alguien renombra un proyecto.
 */

/**
 * Deriva el identificador de artefacto Maven del nombre del proyecto.
 *
 * El nombre es prosa libre («Tienda en línea», «2024 Ventas»), así que la
 * conversión puede dar algo que Maven no acepta: vacío, o empezando por un
 * dígito. En ese caso se usa un nombre neutro en vez de dejar pasar un valor
 * inválido que solo reventaría al generar, cuando ya nadie relaciona el fallo
 * con el nombre que escribió al crear el proyecto. Sigue siendo editable desde
 * los ajustes del diagrama.
 */
function deriveArtifactId(projectName: string): string {
  const candidate = toKebabCase(projectName);
  return /^[a-z][a-z0-9-]*$/.test(candidate) ? candidate : 'proyecto';
}

const CrearProyectoSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(1000).default(''),
  paqueteBase: z.string().trim().optional(),
});

const ActualizarProyectoSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(1000).default(''),
});

const InvitarSchema = z.object({
  email: z.string().trim().min(3),
  rol: z.enum(['editor', 'viewer']).default('editor'),
});

export function projectsRouter(deps: {
  store: ProjectStore;
  identity: IdentityProvider;
  rooms: RoomManager;
  tablon: TablonStore;
  conversations: ConversationStore;
  versiones: VersionStore;
}): Router {
  const { store, identity, rooms, tablon, conversations, versiones } = deps;
  const router = Router();

  router.get(
    '/',
    handler(async (request, response) => {
      response.json({ proyectos: await store.listProjectsForUser(request.user.id) });
    }),
  );

  router.post(
    '/',
    handler(async (request, response) => {
      const body = parseBody(CrearProyectoSchema, request.body);
      const project = await store.createProject({
        name: body.nombre,
        description: body.descripcion,
        ownerId: request.user.id,
      });

      // El documento se crea aquí y no en la primera conexión: así el proyecto
      // recién creado ya tiene metadatos coherentes aunque nadie lo abra, y el
      // generador puede ejecutarse sobre él sin inventarse el paquete base.
      const room = await rooms.open(project.id);
      initializeEmpty(room.doc, {
        name: project.name,
        basePackage: body.paqueteBase ?? 'com.ejemplo.proyecto',
        artifactId: deriveArtifactId(project.name),
        description: project.description,
      });
      await room.save();
      await rooms.closeIfEmpty(project.id);

      response.status(201).json({ proyecto: { ...project, role: 'owner' } });
    }),
  );

  router.get(
    '/:proyectoId',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const project = await store.getProject(request.params.proyectoId ?? '');
      if (!project) throw notFound('El proyecto no existe');
      response.json({ proyecto: { ...project, role: request.role } });
    }),
  );

  router.put(
    '/:proyectoId',
    requireRole(store, 'owner'),
    handler(async (request, response) => {
      const body = parseBody(ActualizarProyectoSchema, request.body);
      const project = await store.renameProject(
        request.params.proyectoId ?? '',
        body.nombre,
        body.descripcion,
      );
      if (!project) throw notFound('El proyecto no existe');
      response.json({ proyecto: { ...project, role: request.role } });
    }),
  );

  router.delete(
    '/:proyectoId',
    requireRole(store, 'owner'),
    handler(async (request, response) => {
      const projectId = request.params.proyectoId ?? '';
      // Se cierra la sala antes de borrar los metadatos: si quedara abierta,
      // seguiría guardando en disco un documento de un proyecto inexistente.
      await rooms.discard(projectId);
      // El tablón va antes que los metadatos y de forma explícita. Con
      // PostgreSQL bastaría el `on delete cascade`, pero con el almacén de
      // fichero no hay cascada que valga: los mensajes y sus notas de voz
      // quedarían en `datos/tablones/` para siempre, ocupando disco y
      // conservando conversaciones de un proyecto que alguien pidió borrar.
      await tablon.borrarProyecto(projectId);
      // Mismo motivo que el tablón: sin esto, el historial del Modo IA de cada
      // miembro quedaría en `datos/conversaciones/` para siempre.
      await conversations.borrarProyecto(projectId);
      // Mismo motivo: sin esto, las versiones guardadas de este proyecto
      // quedarían en `datos/versiones/` para siempre.
      await versiones.borrarProyecto(projectId);
      await store.deleteProject(projectId);
      response.status(204).end();
    }),
  );

  router.get(
    '/:proyectoId/miembros',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const memberships = await store.listMembers(request.params.proyectoId ?? '');
      const miembros = await Promise.all(
        memberships.map(async (membership) => {
          const user = await identity.findById(membership.userId);
          return {
            usuarioId: membership.userId,
            rol: membership.role,
            email: user?.email ?? null,
            nombre: user?.displayName ?? null,
          };
        }),
      );
      response.json({ miembros });
    }),
  );

  router.post(
    '/:proyectoId/miembros',
    requireRole(store, 'owner'),
    handler(async (request, response) => {
      const body = parseBody(InvitarSchema, request.body);
      const invited = await identity.findByEmail(body.email);
      if (!invited) throw notFound('No hay ningún usuario con ese correo');
      if (invited.id === request.user.id) {
        throw badRequest('Ya eres el propietario de este proyecto', 'MIEMBRO_REDUNDANTE');
      }

      const membership = await store.addMember(
        request.params.proyectoId ?? '',
        invited.id,
        body.rol,
      );
      response.status(201).json({
        miembro: {
          usuarioId: membership.userId,
          rol: membership.role,
          email: invited.email,
          nombre: invited.displayName,
        },
      });
    }),
  );

  router.delete(
    '/:proyectoId/miembros/:usuarioId',
    requireRole(store, 'owner'),
    handler(async (request, response) => {
      const projectId = request.params.proyectoId ?? '';
      const userId = request.params.usuarioId ?? '';
      const project = await store.getProject(projectId);
      // Quitar al propietario dejaría el proyecto sin nadie que pueda invitar ni
      // borrarlo: quedaría inaccesible para siempre.
      if (project?.ownerId === userId) {
        throw badRequest('No se puede expulsar al propietario', 'PROPIETARIO_INTOCABLE');
      }

      const removed = await store.removeMember(projectId, userId);
      if (!removed) throw notFound('Esa persona no es miembro del proyecto');

      // Perder el acceso tiene que significar dejar de ver el diagrama, no solo
      // no poder tocarlo: si el socket siguiera abierto, seguiría recibiendo
      // cada cambio de los demás en tiempo real.
      rooms.evictUser(projectId, userId, 'Se te ha retirado el acceso al proyecto');

      response.status(204).end();
    }),
  );

  return router;
}
