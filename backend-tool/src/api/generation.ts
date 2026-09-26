import { Router } from 'express';
import { z } from 'zod';
import type { ClassDiagram } from '@app/shared';
import { readDiagram, toKebabCase } from '@app/shared';
import { generate, generateFlutter, toZipBuffer, validateDiagram } from '@app/generator';
import type { ProjectStore } from '../storage/store.js';
import type { RoomManager } from '../collab/rooms.js';
import { handler, parseBody, requireRole } from './http.js';

/**
 * Generación del backend Spring Boot (RF-GEN-01 … RF-GEN-05).
 *
 * El diagrama se lee del documento colaborativo en el momento de generar, no de
 * una copia enviada por el cliente. Si el cliente mandase el diagrama, dos
 * personas editando a la vez podrían generar proyectos distintos según quién
 * pulsara el botón, y el ZIP no correspondería a lo que hay en el lienzo.
 */

const OpcionesSchema = z.object({
  paqueteBase: z.string().trim().optional(),
  artifactId: z.string().trim().optional(),
  estrategiaHerencia: z.enum(['SINGLE_TABLE', 'JOINED', 'TABLE_PER_CLASS']).optional(),
});

type Opciones = z.infer<typeof OpcionesSchema>;

/**
 * Aplica las opciones de la petición sobre los metadatos del diagrama.
 *
 * No se validan aquí: el paquete y el artefacto acaban en rutas de fichero, y
 * `generate` ya los rechaza con el mismo criterio que aplica al resto del
 * diagrama (RNF-SEG-06). Comprobarlos dos veces con dos reglas distintas es
 * justamente cómo aparecen los huecos.
 */
function withOverrides(diagram: ClassDiagram, options: Opciones): ClassDiagram {
  return {
    ...diagram,
    meta: {
      ...diagram.meta,
      basePackage: options.paqueteBase ?? diagram.meta.basePackage,
      artifactId: options.artifactId ?? diagram.meta.artifactId,
    },
  };
}

export function generationRouter(deps: { store: ProjectStore; rooms: RoomManager }): Router {
  const { store, rooms } = deps;
  const router = Router();

  /**
   * Valida sin generar. La interfaz lo llama mientras se dibuja para señalar los
   * errores junto al elemento afectado (RF-GEN-03), en vez de esperar a que el
   * usuario descubra el problema al descargar.
   */
  router.get(
    '/:proyectoId/validacion',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const room = await rooms.open(request.params.proyectoId ?? '');
      const validation = validateDiagram(readDiagram(room.doc));
      response.json({
        valido: validation.ok,
        errores: validation.errors,
        avisos: validation.warnings,
      });
    }),
  );

  /** Vista previa: el árbol de ficheros y su contenido, sin empaquetar. */
  router.post(
    '/:proyectoId/generacion/previsualizacion',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const options = parseBody(OpcionesSchema, request.body ?? {});
      const room = await rooms.open(request.params.proyectoId ?? '');
      const outcome = generate(withOverrides(readDiagram(room.doc), options), {
        inheritanceStrategy: options.estrategiaHerencia,
      });

      if (!outcome.ok) {
        response.status(422).json({
          error: 'El diagrama todavía no puede generarse',
          code: 'DIAGRAMA_INVALIDO',
          errores: outcome.validation.errors,
        });
        return;
      }

      response.json({
        avisos: outcome.warnings,
        ficheros: outcome.files.map((file) => ({
          ruta: file.path,
          bytes: Buffer.byteLength(file.content, 'utf8'),
          contenido: file.content,
        })),
      });
    }),
  );

  router.post(
    '/:proyectoId/generacion',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const options = parseBody(OpcionesSchema, request.body ?? {});
      const projectId = request.params.proyectoId ?? '';
      const room = await rooms.open(projectId);
      const outcome = generate(withOverrides(readDiagram(room.doc), options), {
        inheritanceStrategy: options.estrategiaHerencia,
      });

      if (!outcome.ok) {
        response.status(422).json({
          error: 'El diagrama todavía no puede generarse',
          code: 'DIAGRAMA_INVALIDO',
          errores: outcome.validation.errors,
        });
        return;
      }

      const zip = await toZipBuffer(outcome.files);
      const project = await store.getProject(projectId);
      const fileName = `${toKebabCase(project?.name ?? 'proyecto') || 'proyecto'}.zip`;

      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      // El cliente lo usa para avisar de problemas que no impiden generar pero
      // que el usuario debería ver; en un ZIP no hay dónde ponerlos si no.
      response.setHeader('X-Avisos', String(outcome.warnings.length));
      response.send(zip);
    }),
  );

  /** Genera el frontend Flutter y lo descarga como ZIP. */
  router.post(
    '/:proyectoId/generacion/flutter',
    requireRole(store, 'viewer'),
    handler(async (request, response) => {
      const options = parseBody(OpcionesSchema, request.body ?? {});
      const projectId = request.params.proyectoId ?? '';
      const room = await rooms.open(projectId);
      const outcome = generate(withOverrides(readDiagram(room.doc), options), {
        inheritanceStrategy: options.estrategiaHerencia,
      });

      if (!outcome.ok) {
        response.status(422).json({
          error: 'El diagrama todavía no puede generarse',
          code: 'DIAGRAMA_INVALIDO',
          errores: outcome.validation.errors,
        });
        return;
      }

      const flutterFiles = generateFlutter(outcome.ir);
      const zip = await toZipBuffer(flutterFiles);
      const project = await store.getProject(projectId);
      const fileName = `${toKebabCase(project?.name ?? 'proyecto') || 'proyecto'}-flutter.zip`;

      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      response.send(zip);
    }),
  );

  return router;
}
