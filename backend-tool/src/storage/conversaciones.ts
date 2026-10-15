import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { esIdSeguroDeFichero } from './tablon.js';

/**
 * Almacén de la conversación con el asistente de IA, por proyecto.
 *
 * Es el quinto almacén de la herramienta y copia la forma de los anteriores:
 * una interfaz, una implementación de fichero y otra contra PostgreSQL.
 *
 * ## Por qué la clave es el proyecto y no el proyecto más el usuario
 *
 * El "modo IA" es un hilo grupal, como el tablón: todos los integrantes del
 * proyecto hablan con la misma IA y la IA ve lo que cada uno le dijo, no solo
 * lo que le dijo quien pregunta ahora. Es la condición que puso el encargo
 * ("contexto de todos los integrantes"), y es lo contrario de lo que hacía
 * esta misma clase antes de esta versión: un hilo privado por `(proyecto,
 * usuario)` que ni la propia IA podía atravesar.
 *
 * Quien escribió cada mensaje de usuario se guarda en `autorId` —igual que
 * `autorId` en `tablon_mensajes`— para poder firmarlo al pintarlo, pero ya no
 * forma parte de la clave de almacenamiento: dos integrantes del mismo
 * proyecto leen y amplían el mismo hilo. Los mensajes del propio asistente no
 * tienen autor humano y llevan `autorId: null`.
 *
 * ## La ventana de 20 turnos
 *
 * Cada turno son dos mensajes (lo que pidió alguien, lo que respondió la IA).
 * Guardar la conversación entera haría crecer sin límite el prompt que se
 * manda al modelo cada vez —y su coste— por un proyecto que lleva meses
 * abierto. Veinte turnos bastan para que la IA entienda "ahora" y "eso que
 * dijiste antes" sin arrastrar una transcripción de semanas, y al ser un hilo
 * de todo el proyecto, esos veinte turnos son los veinte más recientes entre
 * todos sus integrantes, no veinte por cabeza.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  texto: string;
  /** Quién escribió este mensaje. `null` en los mensajes del asistente. */
  autorId: string | null;
  creadoEn: string;
  /**
   * `'respuesta'` es un turno de los de siempre: alguien preguntó o pidió
   * algo y esto es lo que contestó la IA (o lo que preguntó esa persona).
   * `'observacion'` es un mensaje que la IA soltó sola, sin que nadie le
   * escribiera —ver `ai/vigilancia.ts`—, y por eso solo existe en mensajes de
   * rol `assistant`, sin el turno de usuario que normalmente lo acompaña.
   */
  tipo: 'respuesta' | 'observacion';
}

export interface ConversationStore {
  /** Los últimos `limite` mensajes del proyecto, en orden cronológico ascendente. */
  getHistory(proyectoId: string, limite: number): Promise<ChatMessage[]>;
  appendTurn(proyectoId: string, autorId: string, usuario: string, asistente: string): Promise<void>;
  /**
   * Añade un comentario de la IA que nadie ha pedido: un único mensaje de rol
   * `assistant`, sin el turno de usuario que `appendTurn` siempre añade junto
   * a él. Lo usa `ai/vigilancia.ts` cuando decide que el diagrama merece un
   * comentario espontáneo.
   */
  appendComentario(proyectoId: string, texto: string): Promise<void>;
  /** Se llama al borrar el proyecto: se lleva el hilo entero. */
  borrarProyecto(proyectoId: string): Promise<void>;
  close?(): Promise<void>;
}

/** Turnos que se conservan por proyecto. Ver la cabecera del fichero. */
export const MAXIMO_TURNOS = 20;

function exigirIdSeguro(valor: string, que: string): void {
  if (!esIdSeguroDeFichero(valor)) {
    throw new Error(`Identificador de ${que} no admisible como nombre de fichero`);
  }
}

/** Mismo cerrojo que en `tablon.ts`: `slice(-0)` devuelve todo, no nada. */
function limiteSano(limite: number): number {
  return Math.max(1, Math.trunc(limite));
}

/**
 * Lo que de verdad hay en el fichero, que no es lo mismo que `ChatMessage`:
 * un fichero escrito antes de que existiera `tipo` no lo trae. `getHistory`
 * es quien rellena el valor de siempre al leer; el disco se queda tal cual.
 */
type MensajeEnDisco = Omit<ChatMessage, 'tipo'> & { tipo?: ChatMessage['tipo'] };

interface ConversacionEnDisco {
  mensajes: MensajeEnDisco[];
}

function vacia(): ConversacionEnDisco {
  return { mensajes: [] };
}

/**
 * Implementación en disco, la de desarrollo.
 *
 * Un fichero JSON por proyecto. Antes había un directorio por proyecto con un
 * fichero por usuario dentro —necesario cuando cada usuario tenía su propio
 * hilo—; ahora que el hilo es uno solo por proyecto, un fichero plano basta.
 */
export class FileConversationStore implements ConversationStore {
  private readonly directorio: string;
  private readonly cache = new Map<string, ConversacionEnDisco>();
  private colaDeEscritura: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.directorio = join(resolve(dataDir), 'conversaciones');
  }

  private rutaConversacion(proyectoId: string): string {
    exigirIdSeguro(proyectoId, 'proyecto');
    return join(this.directorio, `${proyectoId}.json`);
  }

  private async cargar(proyectoId: string): Promise<ConversacionEnDisco> {
    const enMemoria = this.cache.get(proyectoId);
    if (enMemoria) return enMemoria;

    let conversacion = vacia();
    try {
      conversacion = JSON.parse(
        await readFile(this.rutaConversacion(proyectoId), 'utf8'),
      ) as ConversacionEnDisco;
    } catch (error) {
      // Proyecto sin ninguna conversación todavía: no es un error, es lo
      // normal la primera vez que alguien abre el Modo IA.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.cache.set(proyectoId, conversacion);
    return conversacion;
  }

  /** Se escribe a un temporal y se renombra: ver `tablon.ts` para el motivo. */
  private persistir(proyectoId: string, conversacion: ConversacionEnDisco): void {
    const destino = this.rutaConversacion(proyectoId);
    this.colaDeEscritura = this.colaDeEscritura
      .then(async () => {
        await mkdir(dirname(destino), { recursive: true });
        const temporal = `${destino}.tmp`;
        await writeFile(temporal, JSON.stringify(conversacion, null, 2), 'utf8');
        await rename(temporal, destino);
      })
      .catch((error: unknown) => {
        console.error('No se pudo persistir la conversación:', error);
      });
  }

  /** Espera al volcado pendiente. Solo lo usan las pruebas y el apagado. */
  async flush(): Promise<void> {
    await this.colaDeEscritura;
  }

  async getHistory(proyectoId: string, limite: number): Promise<ChatMessage[]> {
    const tope = limiteSano(limite);
    const conversacion = await this.cargar(proyectoId);
    // Un mensaje guardado por una versión anterior a `tipo` no lo trae: cae en
    // el valor de siempre.
    return conversacion.mensajes.slice(-tope).map((mensaje) => ({ ...mensaje, tipo: mensaje.tipo ?? 'respuesta' }));
  }

  async appendTurn(proyectoId: string, autorId: string, usuario: string, asistente: string): Promise<void> {
    const conversacion = await this.cargar(proyectoId);
    const ahora = new Date();
    conversacion.mensajes.push(
      { role: 'user', texto: usuario, autorId, creadoEn: ahora.toISOString(), tipo: 'respuesta' },
      // Un milisegundo después y no el mismo instante: así el orden de los dos
      // mensajes de un turno no depende de que `Array.push` los haya puesto en
      // ese orden, que es un detalle de esta implementación y no algo que el
      // resto del sistema deba dar por hecho.
      {
        role: 'assistant',
        texto: asistente,
        autorId: null,
        creadoEn: new Date(ahora.getTime() + 1).toISOString(),
        tipo: 'respuesta',
      },
    );

    const sobrantes = conversacion.mensajes.length - MAXIMO_TURNOS * 2;
    if (sobrantes > 0) conversacion.mensajes = conversacion.mensajes.slice(sobrantes);

    this.persistir(proyectoId, conversacion);
  }

  async appendComentario(proyectoId: string, texto: string): Promise<void> {
    const conversacion = await this.cargar(proyectoId);
    conversacion.mensajes.push({
      role: 'assistant',
      texto,
      autorId: null,
      creadoEn: new Date().toISOString(),
      tipo: 'observacion',
    });

    const sobrantes = conversacion.mensajes.length - MAXIMO_TURNOS * 2;
    if (sobrantes > 0) conversacion.mensajes = conversacion.mensajes.slice(sobrantes);

    this.persistir(proyectoId, conversacion);
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    this.cache.delete(proyectoId);
    await this.flush();
    await rm(this.rutaConversacion(proyectoId), { force: true });
  }
}
