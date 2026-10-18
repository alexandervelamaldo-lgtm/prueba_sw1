import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { esIdSeguroDeFichero } from './tablon.js';

/**
 * Almacén de la conversación con el asistente de IA, por proyecto y usuario.
 *
 * Es el quinto almacén de la herramienta y copia la forma de los anteriores:
 * una interfaz, una implementación de fichero y otra contra PostgreSQL.
 *
 * ## Por qué la clave es el proyecto más el usuario
 *
 * Cada integrante del proyecto tiene su propio hilo con la IA, y los demás
 * colaboradores no lo ven. El hilo compartido por proyecto de la versión
 * anterior se descartó a pedido de quien usa la herramienta: las sesiones con
 * la IA son de cada colaborador, no del equipo. Para pasarle algo al resto
 * está el tablón.
 *
 * `hiloDe` es el dueño del hilo y está en todos los mensajes, también en los
 * del asistente. `autorId` sigue siendo quién escribió el mensaje (`null` en
 * los del asistente). Los mensajes guardados en la época del hilo compartido
 * no tienen `hiloDe` y no aparecen en ningún hilo: mezclaban a varios
 * integrantes y no hay forma de saber de quién era cada respuesta.
 *
 * ## La ventana de 20 turnos
 *
 * Cada turno son dos mensajes (lo que pidió alguien, lo que respondió la IA).
 * Guardar la conversación entera haría crecer sin límite el prompt que se
 * manda al modelo cada vez —y su coste— por un proyecto que lleva meses
 * abierto. Veinte turnos por hilo bastan para que la IA entienda "ahora" y
 * "eso que dijiste antes" sin arrastrar una transcripción de semanas.
 *
 * Lo que sale de la ventana no se olvida del todo: antes de podarlo, la IA lo
 * resume (`AssistantEngine.resumirConversacion`) y ese resumen se guarda aparte,
 * uno por hilo, para mandarlo como contexto (`getResumen` / `setResumen`).
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
  /** Los últimos `limite` mensajes del hilo de `usuarioId` en el proyecto, en orden cronológico ascendente. */
  getHistory(proyectoId: string, usuarioId: string, limite: number): Promise<ChatMessage[]>;
  /**
   * Añade un turno al hilo de `usuarioId`, que es también quien escribió la
   * orden. Devuelve los mensajes de ese hilo que salieron de la ventana al
   * guardarlo, del más antiguo al más reciente: son los que hay que resumir.
   */
  appendTurn(proyectoId: string, usuarioId: string, usuario: string, asistente: string): Promise<ChatMessage[]>;
  /**
   * Añade un comentario de la IA que nadie ha pedido al hilo de `usuarioId`:
   * un único mensaje de rol `assistant`, sin el turno de usuario que
   * `appendTurn` siempre añade junto a él. Lo usa `ai/vigilancia.ts` cuando
   * decide que el diagrama merece un comentario espontáneo.
   */
  appendComentario(proyectoId: string, usuarioId: string, texto: string): Promise<void>;
  /** El resumen de lo que ya salió de la ventana de este hilo, o `null`. */
  getResumen(proyectoId: string, usuarioId: string): Promise<string | null>;
  setResumen(proyectoId: string, usuarioId: string, resumen: string): Promise<void>;
  /** Se llama al borrar el proyecto: se lleva los hilos de todos sus integrantes. */
  borrarProyecto(proyectoId: string): Promise<void>;
  close?(): Promise<void>;
}

/** Turnos que se conservan por hilo. Ver la cabecera del fichero. */
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
type MensajeEnDisco = Omit<ChatMessage, 'tipo'> & {
  tipo?: ChatMessage['tipo'];
  /** Dueño del hilo. Falta en los mensajes de la época del hilo compartido. */
  hiloDe?: string;
};

interface ConversacionEnDisco {
  mensajes: MensajeEnDisco[];
  /** Resumen por dueño del hilo. Falta en ficheros anteriores a la memoria resumida. */
  resumenes?: Record<string, string>;
}

function vacia(): ConversacionEnDisco {
  return { mensajes: [] };
}

/**
 * Implementación en disco, la de desarrollo.
 *
 * Un fichero JSON por proyecto con los hilos de todos sus integrantes,
 * separados por `hiloDe`. El usuario no forma parte de la ruta, así que su id
 * no tiene que ser un nombre de fichero seguro.
 */
export class FileConversationStore implements ConversationStore {
  private readonly directorio: string;
  // La lectura de cada proyecto, compartida: dos pedidos que llegan antes de
  // que termine la primera carga tienen que trabajar sobre el mismo objeto, o
  // el segundo en cargar pisaría lo que añadió el primero.
  private readonly cache = new Map<string, Promise<ConversacionEnDisco>>();
  private colaDeEscritura: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.directorio = join(resolve(dataDir), 'conversaciones');
  }

  private rutaConversacion(proyectoId: string): string {
    exigirIdSeguro(proyectoId, 'proyecto');
    return join(this.directorio, `${proyectoId}.json`);
  }

  private cargar(proyectoId: string): Promise<ConversacionEnDisco> {
    const enCurso = this.cache.get(proyectoId);
    if (enCurso) return enCurso;

    const carga = (async () => {
      try {
        return JSON.parse(await readFile(this.rutaConversacion(proyectoId), 'utf8')) as ConversacionEnDisco;
      } catch (error) {
        // Proyecto sin ninguna conversación todavía: no es un error, es lo
        // normal la primera vez que alguien abre el Modo IA.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return vacia();
      }
    })();
    this.cache.set(proyectoId, carga);
    // Un fallo de lectura no se queda guardado: el siguiente pedido vuelve a probar.
    carga.catch(() => {
      if (this.cache.get(proyectoId) === carga) this.cache.delete(proyectoId);
    });
    return carga;
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

  async getHistory(proyectoId: string, usuarioId: string, limite: number): Promise<ChatMessage[]> {
    const tope = limiteSano(limite);
    const conversacion = await this.cargar(proyectoId);
    return conversacion.mensajes
      .filter((mensaje) => mensaje.hiloDe === usuarioId)
      .slice(-tope)
      .map(({ hiloDe: _hilo, ...mensaje }) => ({
        ...mensaje,
        // Un mensaje guardado por una versión anterior a `tipo` no lo trae:
        // cae en el valor de siempre.
        tipo: mensaje.tipo ?? 'respuesta',
      }));
  }

  /**
   * Deja en el hilo de `usuarioId` solo sus últimos mensajes; los demás hilos
   * no se tocan. Devuelve los que quitó, en orden.
   */
  private recortar(conversacion: ConversacionEnDisco, usuarioId: string): ChatMessage[] {
    const delHilo = conversacion.mensajes.filter((mensaje) => mensaje.hiloDe === usuarioId);
    const quitados = delHilo.slice(0, Math.max(0, delHilo.length - MAXIMO_TURNOS * 2));
    if (quitados.length === 0) return [];
    const sobrantes = new Set(quitados);
    conversacion.mensajes = conversacion.mensajes.filter((mensaje) => !sobrantes.has(mensaje));
    return quitados.map(({ hiloDe: _hilo, ...mensaje }) => ({ ...mensaje, tipo: mensaje.tipo ?? 'respuesta' }));
  }

  async appendTurn(proyectoId: string, usuarioId: string, usuario: string, asistente: string): Promise<ChatMessage[]> {
    const conversacion = await this.cargar(proyectoId);
    const ahora = new Date();
    conversacion.mensajes.push(
      {
        role: 'user',
        texto: usuario,
        autorId: usuarioId,
        creadoEn: ahora.toISOString(),
        tipo: 'respuesta',
        hiloDe: usuarioId,
      },
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
        hiloDe: usuarioId,
      },
    );

    const podados = this.recortar(conversacion, usuarioId);
    this.persistir(proyectoId, conversacion);
    return podados;
  }

  async appendComentario(proyectoId: string, usuarioId: string, texto: string): Promise<void> {
    const conversacion = await this.cargar(proyectoId);
    conversacion.mensajes.push({
      role: 'assistant',
      texto,
      autorId: null,
      creadoEn: new Date().toISOString(),
      tipo: 'observacion',
      hiloDe: usuarioId,
    });

    this.recortar(conversacion, usuarioId);
    this.persistir(proyectoId, conversacion);
  }

  async getResumen(proyectoId: string, usuarioId: string): Promise<string | null> {
    const conversacion = await this.cargar(proyectoId);
    return conversacion.resumenes?.[usuarioId] ?? null;
  }

  async setResumen(proyectoId: string, usuarioId: string, resumen: string): Promise<void> {
    const conversacion = await this.cargar(proyectoId);
    conversacion.resumenes = { ...conversacion.resumenes, [usuarioId]: resumen };
    this.persistir(proyectoId, conversacion);
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    this.cache.delete(proyectoId);
    await this.flush();
    await rm(this.rutaConversacion(proyectoId), { force: true });
  }
}

