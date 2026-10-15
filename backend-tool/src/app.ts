import { join, resolve } from 'node:path';
import express, { type Express } from 'express';
import cors from 'cors';
import type { Config } from './config.js';
import { LocalIdentityProvider, type IdentityProvider } from './auth/identity.js';
import { FileProjectStore, type ProjectStore } from './storage/store.js';
import { FileDocumentStore } from './storage/documents.js';
import { FileTablonStore, type TablonStore } from './storage/tablon.js';
import { FileConversationStore, type ConversationStore } from './storage/conversaciones.js';
import { FileVersionStore, type VersionStore } from './storage/versiones.js';
import { RoomManager } from './collab/rooms.js';
import { CollabServer } from './collab/server.js';
import { createAssistant, type AssistantEngine } from './ai/assistant.js';
import { VigilanteDiagrama } from './ai/vigilancia.js';
import { createVisionEngine, type VisionEngine } from './ai/vision.js';
import { GuiaDelManual } from './ai/guia.js';
import { authRouter } from './api/auth.js';
import { guiaRouter } from './api/guia.js';
import { projectsRouter } from './api/projects.js';
import { panelRouter } from './api/panel.js';
import { diagramsRouter } from './api/diagrams.js';
import { generationRouter } from './api/generation.js';
import { assistantRouter } from './api/assistant.js';
import { importRouter } from './api/import.js';
import { tablonRouter } from './api/tablon.js';
import { versionesRouter } from './api/versiones.js';
import { errorHandler, notFound, requireAuth } from './api/http.js';
import { cabecerasDeSeguridad, limiteDeTasa } from './api/proteccion.js';

/**
 * Composición del servicio.
 *
 * Todas las dependencias se construyen aquí y se inyectan. Es lo que permite que
 * las pruebas levanten la aplicación entera contra un directorio temporal sin
 * tocar variables de entorno ni abrir puertos, y lo que hará que sustituir el
 * almacén de fichero por PostgreSQL sea un cambio de una línea.
 */

/**
 * Las cuotas, con sus números escritos donde se pueden discutir.
 *
 * Se eligen por encima de lo que hace una persona trabajando y muy por debajo de
 * lo que hace un bucle: nadie dicta treinta órdenes en un minuto ni fotografía
 * diez pizarras seguidas, pero un script las pide en dos segundos. La ventana es
 * de un minuto porque es lo que dura la paciencia de quien se choca con el
 * límite por accidente.
 */
const LIMITE_IA = { ventanaMs: 60_000, maximo: 30, nombre: 'al asistente' };
const LIMITE_IMAGEN = { ventanaMs: 60_000, maximo: 10, nombre: 'de lectura de imágenes' };
const LIMITE_GENERACION = { ventanaMs: 60_000, maximo: 10, nombre: 'de generación de código' };

export interface AppDependencies {
  config: Config;
  identity: IdentityProvider;
  store: ProjectStore;
  rooms: RoomManager;
  /** El tablón del proyecto: comunicación interna por texto y por voz. */
  tablon: TablonStore;
  /** El historial del Modo IA: un hilo por proyecto, compartido por todos sus integrantes. */
  conversations: ConversationStore;
  /** Los puntos de control que alguien crea a propósito, para poder volver a ellos. */
  versiones: VersionStore;
  assistant: AssistantEngine;
  /** Ausente si esta instalación no tiene modelo de visión configurado. */
  vision?: VisionEngine;
  /** Ausente si no se encontró el directorio de documentación. */
  guia?: GuiaDelManual;
}

export interface BuiltApp {
  app: Express;
  collab: CollabServer;
  deps: AppDependencies;
}

/**
 * Construye las dependencias a partir de la configuración.
 *
 * La presencia de `DATABASE_URL` es lo único que decide dónde se guarda todo.
 * Los cuatro almacenes se eligen juntos y nunca por separado: media aplicación
 * en PostgreSQL y media en disco significaría, por ejemplo, permisos que
 * sobreviven al despliegue apuntando a usuarios que no, y nadie podría entrar en
 * su propio proyecto.
 */
export async function createDependencies(config: Config): Promise<AppDependencies> {
  const almacenes = config.databaseUrl
    ? await almacenesPostgres(config, config.databaseUrl)
    : await almacenesDeFichero(config);

  return {
    config,
    ...almacenes,
    assistant: createAssistant(config),
    vision: createVisionEngine(config),
    guia: await abrirGuia(config),
  };
}

/**
 * Carga el manual, si está donde se dijo.
 *
 * Que falte no impide arrancar. La guía es ayuda: sin ella se siguen editando
 * diagramas y generando backends, y quedarse sin servicio porque no se copió un
 * directorio de Markdown sería una avería que nos habríamos buscado nosotros.
 * El aviso queda en el registro para que no pase inadvertido.
 */
async function abrirGuia(config: Config): Promise<GuiaDelManual | undefined> {
  try {
    return await GuiaDelManual.abrir(config.docsDir, {
      ...(config.llmApiKey ? { apiKey: config.llmApiKey } : {}),
      ...(config.llmModel ? { model: config.llmModel } : {}),
      ...(config.llmBaseUrl ? { baseUrl: config.llmBaseUrl } : {}),
    });
  } catch (error) {
    console.warn(
      `La guía queda desactivada: no se pudo leer ${config.docsDir}`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

type Almacenes = Pick<
  AppDependencies,
  'identity' | 'store' | 'rooms' | 'tablon' | 'conversations' | 'versiones'
>;

async function almacenesDeFichero(config: Config): Promise<Almacenes> {
  return {
    identity: await LocalIdentityProvider.open(
      config.dataDir,
      config.sessionSecret,
      config.sessionTtl,
    ),
    store: await FileProjectStore.open(config.dataDir),
    rooms: new RoomManager(new FileDocumentStore(config.dataDir), config.persistIntervalMs),
    tablon: new FileTablonStore(config.dataDir),
    conversations: new FileConversationStore(config.dataDir),
    versiones: new FileVersionStore(config.dataDir),
  };
}

/**
 * `pg` se carga aquí dentro, no arriba: es una dependencia opcional y una
 * instalación sin base de datos no debe necesitarla para arrancar.
 */
async function almacenesPostgres(config: Config, databaseUrl: string): Promise<Almacenes> {
  const { abrirPool, aplicarEsquema } = await import('./storage/postgres.js');
  const {
    PostgresConversationStore,
    PostgresDocumentStore,
    PostgresIdentityProvider,
    PostgresProjectStore,
    PostgresTablonStore,
    PostgresVersionStore,
  } = await import('./storage/postgres-stores.js');

  const pool = await abrirPool(databaseUrl);
  await aplicarEsquema(pool);

  return {
    identity: new PostgresIdentityProvider(pool, config.sessionSecret, config.sessionTtl),
    store: new PostgresProjectStore(pool),
    // El almacén de documentos es el dueño del pool porque su `close()` lo llama
    // `RoomManager.shutdown()`, que es el último paso del apagado.
    rooms: new RoomManager(new PostgresDocumentStore(pool), config.persistIntervalMs),
    // Comparte el pool y no lo cierra: un segundo dueño del mismo pool haría
    // que el primer apagado dejara al otro escribiendo contra un pool cerrado.
    tablon: new PostgresTablonStore(pool),
    conversations: new PostgresConversationStore(pool),
    versiones: new PostgresVersionStore(pool),
  };
}

export function createApp(deps: AppDependencies): BuiltApp {
  const { config, identity, store, rooms, tablon, conversations, versiones, assistant, vision, guia } =
    deps;
  const app = express();

  app.disable('x-powered-by');
  // Antes que nada, para que las cabeceras acompañen también a los errores y a
  // las respuestas de los ficheros estáticos.
  app.use(cabecerasDeSeguridad());
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      credentials: true,
    }),
  );
  // El límite es holgado para las importaciones de diagrama y estrecho frente a
  // lo que cabría enviar por descuido; el canal colaborativo tiene el suyo.
  //
  // Se deriva del máximo de imagen porque una foto viaja en base64, que abulta
  // un tercio más, y el JSON que la envuelve añade lo suyo. Antes estaba fijo en
  // 4 MB y una foto de 4 MiB —justo la que la ruta dice admitir— rebotaba aquí,
  // en el middleware, con un error genérico de Express en lugar del mensaje que
  // explica qué hacer.
  const limiteCuerpo = Math.ceil((config.maxImageBytes * 4) / 3) + 512 * 1024;
  app.use(express.json({ limit: limiteCuerpo }));

  // El vigilante se construye aquí y no en `createDependencies`: no es un
  // almacén que pueda sustituirse por PostgreSQL, es un comportamiento que
  // combina dos dependencias que ya existen (el asistente y su historial), y
  // a las pruebas que levantan la aplicación entera les basta con que exista,
  // sin tener que saber nada de él.
  const vigilante = new VigilanteDiagrama(assistant, conversations);
  const collab = new CollabServer({ config, identity, store, rooms, vigilante });

  app.get('/salud', (_request, response) => {
    response.json({
      estado: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      salasAbiertas: rooms.openRoomIds.length,
      conexiones: collab.connectionCount,
    });
  });

  app.use('/api/auth', authRouter(identity));

  // La guía no cuelga de ningún proyecto porque no habla de ninguno: habla de
  // la herramienta, y la pregunta «¿por dónde empiezo?» se hace justamente antes
  // de tener un proyecto abierto. Sí exige sesión, porque cada respuesta del
  // modelo se paga con una clave nuestra.
  if (guia) {
    app.use('/api/guia', requireAuth(identity), limiteDeTasa(LIMITE_IA), guiaRouter(guia));
  }

  // Todo lo que hay bajo /api/proyectos exige sesión. Ponerlo una vez aquí evita
  // que una ruta nueva quede accesible por olvidar el middleware.
  const protectedApi = express.Router();
  protectedApi.use(requireAuth(identity));
  // Las rutas caras llevan límite de tasa y las demás no: generar un proyecto,
  // preguntarle al asistente y leer una foto cuestan tiempo de CPU o dinero de
  // una clave nuestra, mientras que listar proyectos cuesta una lectura. Poner
  // el límite donde no hace falta solo consigue que un usuario legítimo se
  // choque con él (RNF-SEG-08).
  //
  // Se montan por camino y no envolviendo el router: `use(mw, router)` ejecuta
  // el middleware en *toda* petición que entre en `protectedApi`, así que abrir
  // un diagrama gastaría cuota de generación.
  const tasaDeImagen = limiteDeTasa(LIMITE_IMAGEN);
  protectedApi.use('/:proyectoId/generacion', limiteDeTasa(LIMITE_GENERACION));
  protectedApi.use('/:proyectoId/asistente', limiteDeTasa(LIMITE_IA));
  // Las dos importaciones comparten contador: son la misma clave y el mismo
  // gasto, y con contadores separados el máximo real sería el doble.
  protectedApi.use('/:proyectoId/importar-tabla', tasaDeImagen);
  protectedApi.use('/:proyectoId/importar-diagrama', tasaDeImagen);
  protectedApi.use(projectsRouter({ store, identity, rooms, tablon, conversations, versiones }));
  protectedApi.use(diagramsRouter({ store, rooms }));
  protectedApi.use(versionesRouter({ store, rooms, versiones }));
  // El tablón no lleva límite de tasa montado aquí: su cuota se aplica ruta a
  // ruta dentro del router, porque el sondeo comparte camino con la publicación
  // y un límite común lo apagaría solo. Ver la cabecera de `api/tablon.ts`.
  protectedApi.use(tablonRouter({ store, identity, tablon }));
  protectedApi.use(generationRouter({ store, rooms }));
  protectedApi.use(assistantRouter({ store, identity, rooms, assistant, conversations }));
  protectedApi.use(importRouter({ store, rooms, vision, maxImageBytes: config.maxImageBytes }));
  app.use('/api/proyectos', protectedApi);

  // El panel no cuelga de `/api/proyectos` porque no habla de un proyecto: habla
  // de todos los de quien pregunta a la vez. Colgarlo de ahí lo habría dejado
  // compitiendo con `/:proyectoId`, que casa con cualquier segmento y se habría
  // tragado la ruta.
  app.use('/api/panel', requireAuth(identity), panelRouter({ store, rooms }));

  // La API va antes que los ficheros estáticos: si el frontend se montase
  // primero, su comodín se tragaría `/api/...` y devolvería el `index.html` con
  // un 200, que es el fallo más desconcertante de todos —el cliente recibe HTML
  // donde espera JSON y el error acaba siendo «Unexpected token <».
  if (config.frontendDir) {
    servirFrontend(app, config.frontendDir);
  }

  app.use((_request, _response, next) => next(notFound('Ruta no encontrada')));
  app.use(errorHandler);

  return { app, collab, deps };
}

/**
 * Sirve el frontend construido desde el propio servicio.
 *
 * No es una comodidad de despliegue: el cliente deriva la URL del canal
 * colaborativo de `location.host`, así que servir el frontend desde otro origen
 * —un bucket, un CDN, un servicio estático aparte— haría que el navegador
 * buscase el WebSocket en el host del frontend, donde no hay nadie escuchando.
 * Mismo origen, además, deja CORS sin nada que hacer.
 */
function servirFrontend(app: Express, frontendDir: string): void {
  const raiz = resolve(frontendDir);

  // Los ficheros con hash en el nombre se pueden cachear para siempre; el
  // `index.html` no, porque es quien apunta a la versión nueva de todo lo demás.
  // Cachearlo dejaría a los navegadores pidiendo ficheros que ya no existen.
  app.use(
    express.static(raiz, {
      index: false,
      setHeaders(response, ruta) {
        response.setHeader(
          'Cache-Control',
          ruta.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
      },
    }),
  );

  // Rutas del cliente: `/proyectos/:id` no es un fichero, y sin esto una recarga
  // dentro de la aplicación daría 404. Se excluyen la API y el canal
  // colaborativo, que tienen que poder fallar con su propio error.
  app.get(/^\/(?!api\/|colaboracion\b|salud\b).*/, (_request, response, next) => {
    // La cabecera se pone aquí y no en `setHeaders`: como el estático va con
    // `index: false`, el `index.html` sale siempre por esta vía, y `sendFile`
    // traía su propio `public, max-age=0`.
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(join(raiz, 'index.html'), (error?: Error) => {
      // Sin `dist/` construido el fichero no existe. Se delega en el manejador
      // de errores en vez de dejar la petición colgada.
      if (error) next(notFound('El frontend no está construido en este despliegue'));
    });
  });
}
