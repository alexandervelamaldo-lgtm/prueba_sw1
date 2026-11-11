import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { esIdSeguroDeFichero } from './tablon.js';

/**
 * Almacén de la conversación con el asistente de IA, un hilo por proyecto.
 *
 * Es el quinto almacén de la herramienta y copia la forma de los anteriores:
 * una interfaz, una implementación de fichero y otra contra PostgreSQL.
 *
 * ## Por qué el hilo es del proyecto y no de cada usuario
 *
 * Hubo una versión anterior con un hilo privado por integrante: cada quien
 * tenía su propia conversación con la IA y los demás colaboradores no la
 * veían. Se revierte a pedido de quien usa la herramienta porque no refleja
 * cómo se usa en la práctica: el lienzo ya es compartido en vivo (RF-COL-01),
 * y una conversación sobre ese mismo diagrama que solo ve quien la escribió
 * obliga a repetirle a la IA lo que un compañero ya le preguntó, o a que
 * nadie se entere de que alguien más ya resolvió la misma duda. El tablón
 * siempre fue el sitio para avisar al resto; esto hace que el chat con la IA
 * también lo sea, sin que haga falta copiar nada a mano.
 *
 * `autorId` sigue siendo quién escribió cada mensaje (`null` en los del
 * asistente): no identifica el hilo, identifica a la persona, y sirve para
 * pintar «quién dijo qué» en una conversación que ahora tiene más de un
 * participante humano.
 *
 * ## La ventana de 20 turnos
 *
 * Cada turno son dos mensajes (lo que pidió alguien, lo que respondió la IA).
 * Guardar la conversación entera haría crecer sin límite el prompt que se
 * manda al modelo cada vez —y su coste— por un proyecto que lleva meses
 * abierto. Veinte turnos por proyecto bastan para que la IA entienda "ahora" y
 * "eso que dijiste antes" sin arrastrar una transcripción de semanas.
 *
 * Lo que sale de la ventana no se olvida del todo: antes de podarlo, la IA lo
 * resume (`AssistantEngine.resumirConversacion`) y ese resumen se guarda aparte,
 * uno por proyecto, para mandarlo como contexto (`getResumen` / `setResumen`).
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
  /** Los últimos `limite` mensajes del hilo del proyecto, en orden cronológico ascendente. */
  getHistory(proyectoId: string, limite: number): Promise<ChatMessage[]>;
  /**
   * Añade un turno al hilo del proyecto. `autorId` es quién escribió la
   * orden. Devuelve los mensajes de ese hilo que salieron de la ventana al
   * guardarlo, del más antiguo al más reciente: son los que hay que resumir.
   */
  appendTurn(proyectoId: string, autorId: string, usuario: string, asistente: string): Promise<ChatMessage[]>;
  /**
   * Añade un comentario de la IA que nadie ha pedido al hilo del proyecto:
   * un único mensaje de rol `assistant`, sin el turno de usuario que
   * `appendTurn` siempre añade junto a él. Lo usa `ai/vigilancia.ts` cuando
   * decide que el diagrama merece un comentario espontáneo. Devuelve, como
   * `appendTurn`, los mensajes del hilo que salieron de la ventana.
   */
  appendComentario(proyectoId: string, texto: string): Promise<ChatMessage[]>;
  /** El resumen de lo que ya salió de la ventana de este proyecto, o `null`. */
  getResumen(proyectoId: string): Promise<string | null>;
  setResumen(proyectoId: string, resumen: string): Promise<void>;
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
 *
 * `hiloDe` también puede estar presente en ficheros de la versión con un
 * hilo por integrante: se ignora al leer. Los mensajes ya estaban en un único
 * array por proyecto, en orden de llegada, así que todos entran en el hilo
 * fusionado sin ninguna transformación aparte de dejar de filtrar por ese
 * campo.
 */
type MensajeEnDisco = Omit<ChatMessage, 'tipo'> & {
  tipo?: ChatMessage['tipo'];
  /** Dueño del hilo en la versión anterior. Se ignora al leer. */
  hiloDe?: string;
};

interface ConversacionEnDisco {
  mensajes: MensajeEnDisco[];
  /**
   * Resumen del proyecto. Antes era `Record<usuarioId, string>` —un resumen
   * por hilo—; ninguno de esos resúmenes individuales resume la conversación
   * fusionada, así que no se migran: se leen como si no existieran y la IA
   * genera uno nuevo para el proyecto entero en el próximo corte de la
   * ventana.
   */
  resumen?: string;
}

function vacia(): ConversacionEnDisco {
  return { mensajes: [] };
}

/**
 * Implementación en disco, la de desarrollo.
 *
 * Un fichero JSON por proyecto con su hilo entero.
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

  async getHistory(proyectoId: string, limite: number): Promise<ChatMessage[]> {
    const tope = limiteSano(limite);
    const conversacion = await this.cargar(proyectoId);
    return conversacion.mensajes.slice(-tope).map(({ hiloDe: _hilo, ...mensaje }) => ({
      ...mensaje,
      // Un mensaje guardado por una versión anterior a `tipo` no lo trae:
      // cae en el valor de siempre.
      tipo: mensaje.tipo ?? 'respuesta',
    }));
  }

  /** Deja en el proyecto solo sus últimos mensajes. Devuelve los que quitó, en orden. */
  private recortar(conversacion: ConversacionEnDisco): ChatMessage[] {
    const quitados = conversacion.mensajes.slice(0, Math.max(0, conversacion.mensajes.length - MAXIMO_TURNOS * 2));
    if (quitados.length === 0) return [];
    conversacion.mensajes = conversacion.mensajes.slice(quitados.length);
    return quitados.map(({ hiloDe: _hilo, ...mensaje }) => ({ ...mensaje, tipo: mensaje.tipo ?? 'respuesta' }));
  }

  async appendTurn(proyectoId: string, autorId: string, usuario: string, asistente: string): Promise<ChatMessage[]> {
    const conversacion = await this.cargar(proyectoId);
    const ahora = new Date();
    conversacion.mensajes.push(
      {
        role: 'user',
        texto: usuario,
        autorId,
        creadoEn: ahora.toISOString(),
        tipo: 'respuesta',
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
      },
    );

    const podados = this.recortar(conversacion);
    this.persistir(proyectoId, conversacion);
    return podados;
  }

  async appendComentario(proyectoId: string, texto: string): Promise<ChatMessage[]> {
    const conversacion = await this.cargar(proyectoId);
    conversacion.mensajes.push({
      role: 'assistant',
      texto,
      autorId: null,
      creadoEn: new Date().toISOString(),
      tipo: 'observacion',
    });

    const podados = this.recortar(conversacion);
    this.persistir(proyectoId, conversacion);
    return podados;
  }

  async getResumen(proyectoId: string): Promise<string | null> {
    const conversacion = await this.cargar(proyectoId);
    return conversacion.resumen ?? null;
  }

  async setResumen(proyectoId: string, resumen: string): Promise<void> {
    const conversacion = await this.cargar(proyectoId);
    conversacion.resumen = resumen;
    this.persistir(proyectoId, conversacion);
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    this.cache.delete(proyectoId);
    await this.flush();
    await rm(this.rutaConversacion(proyectoId), { force: true });
  }
}
