import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { esIdSeguroDeFichero } from './tablon.js';

/**
 * Almacén de versiones del proyecto: los puntos de control que alguien crea a
 * propósito para poder volver a ellos más tarde.
 *
 * Es el sexto almacén de la herramienta y sigue la misma forma que los
 * anteriores: una interfaz, una implementación de fichero para desarrollar sin
 * base de datos y otra contra PostgreSQL para el despliegue.
 *
 * ## Por qué el estado va en un fichero aparte del índice
 *
 * Igual que el audio del tablón: `estado` es el documento Yjs entero
 * (`Y.encodeStateAsUpdate`), un blob que solo crece. Si viviera dentro del
 * mismo JSON que la lista de versiones, listar las versiones de un proyecto
 * —la consulta de abrir el panel de historial— tendría que leer y volver a
 * escribir en memoria todos los blobs acumulados solo para enseñar sus
 * mensajes y fechas. Separarlo deja el índice ligero y el blob se lee una
 * sola vez, cuando alguien pide restaurar justo esa versión.
 *
 * ## Por qué no hay límite ni poda aquí
 *
 * A diferencia del tablón o de las conversaciones con la IA, una versión no
 * la crea una escritura automática sino una persona pulsando «guardar
 * versión». El ritmo de llegada es otro, y podar en silencio invalidaría lo
 * que esto existe para ofrecer: poder volver a un punto concreto. Ver el
 * comentario de `versiones_proyecto` en `sql/esquema.sql`.
 */

export interface Version {
  id: string;
  proyectoId: string;
  /** El documento Yjs entero, tal como lo devolvió `Y.encodeStateAsUpdate`. */
  estado: Uint8Array;
  mensaje: string;
  autorId: string;
  creadoEn: string;
}

/** Lo que hace falta para pintar la línea de tiempo, sin el blob del estado. */
export type VersionResumen = Omit<Version, 'estado'>;

export interface CrearVersion {
  proyectoId: string;
  estado: Uint8Array;
  mensaje: string;
  autorId: string;
}

export interface VersionStore {
  crear(entrada: CrearVersion): Promise<VersionResumen>;
  /** En orden cronológico ascendente, igual que `versiones_por_proyecto`. */
  listar(proyectoId: string): Promise<VersionResumen[]>;
  /** `null` si la versión no existe o no es de ese proyecto. */
  obtener(proyectoId: string, versionId: string): Promise<Version | null>;
  /** Se llama al borrar el proyecto. Se lleva los estados por delante. */
  borrarProyecto(proyectoId: string): Promise<void>;
  close?(): Promise<void>;
}

function exigirIdSeguro(valor: string, que: string): void {
  if (!esIdSeguroDeFichero(valor)) {
    throw new Error(`Identificador de ${que} no admisible como nombre de fichero`);
  }
}

interface VersionesEnDisco {
  versiones: VersionResumen[];
}

function vacio(): VersionesEnDisco {
  return { versiones: [] };
}

/**
 * Compara solo por fecha. Dos versiones creadas en el mismo milisegundo
 * quedan en el orden en que se crearon: el fichero las guarda en ese orden
 * (`push`) y `sort` es estable. Desempatar por `id`, como antes, las dejaba al
 * azar, porque el id es un UUID aleatorio. En PostgreSQL el desempate por id
 * del índice `versiones_por_proyecto` no llega a usarse: `now()` tiene
 * precisión de microsegundos y cada versión es su propia transacción.
 */
function compararOrden(a: VersionResumen, b: VersionResumen): number {
  return a.creadoEn.localeCompare(b.creadoEn);
}

/**
 * Implementación en disco, la de desarrollo.
 *
 * Un fichero JSON por proyecto con el índice de versiones, y un fichero
 * suelto por cada estado. Mismo motivo que separa el audio del tablón: el
 * índice se reescribe entero en cada «guardar versión», y con los estados
 * dentro cada guardado reescribiría en disco todas las versiones anteriores
 * del proyecto.
 */
export class FileVersionStore implements VersionStore {
  private readonly directorio: string;
  private readonly cache = new Map<string, VersionesEnDisco>();
  private colaDeEscritura: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.directorio = join(resolve(dataDir), 'versiones');
  }

  private rutaIndice(proyectoId: string): string {
    exigirIdSeguro(proyectoId, 'proyecto');
    return join(this.directorio, `${proyectoId}.json`);
  }

  private rutaEstado(versionId: string): string {
    exigirIdSeguro(versionId, 'versión');
    return join(this.directorio, 'estado', `${versionId}.bin`);
  }

  private async cargar(proyectoId: string): Promise<VersionesEnDisco> {
    const enMemoria = this.cache.get(proyectoId);
    if (enMemoria) return enMemoria;

    let versiones = vacio();
    try {
      versiones = JSON.parse(await readFile(this.rutaIndice(proyectoId), 'utf8')) as VersionesEnDisco;
    } catch (error) {
      // Proyecto sin ninguna versión todavía: no es un error, es lo normal
      // hasta que alguien pulsa «guardar versión» por primera vez.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.cache.set(proyectoId, versiones);
    return versiones;
  }

  /** Se escribe a un temporal y se renombra: ver `tablon.ts` para el motivo. */
  private persistir(proyectoId: string, versiones: VersionesEnDisco): void {
    const destino = this.rutaIndice(proyectoId);
    this.colaDeEscritura = this.colaDeEscritura
      .then(async () => {
        await mkdir(dirname(destino), { recursive: true });
        const temporal = `${destino}.tmp`;
        await writeFile(temporal, JSON.stringify(versiones, null, 2), 'utf8');
        await rename(temporal, destino);
      })
      .catch((error: unknown) => {
        console.error('No se pudo persistir las versiones:', error);
      });
  }

  /** Espera al volcado pendiente. Solo lo usan las pruebas y el apagado. */
  async flush(): Promise<void> {
    await this.colaDeEscritura;
  }

  async crear(entrada: CrearVersion): Promise<VersionResumen> {
    exigirIdSeguro(entrada.proyectoId, 'proyecto');
    const id = randomUUID();
    const ruta = this.rutaEstado(id);
    await mkdir(dirname(ruta), { recursive: true });
    // El estado se escribe antes de registrar la versión en el índice: al
    // revés, un fallo de disco entre las dos escrituras dejaría una versión
    // listada en el panel que no se puede restaurar porque su blob no existe.
    await writeFile(ruta, entrada.estado);

    const versiones = await this.cargar(entrada.proyectoId);
    const resumen: VersionResumen = {
      id,
      proyectoId: entrada.proyectoId,
      mensaje: entrada.mensaje,
      autorId: entrada.autorId,
      creadoEn: new Date().toISOString(),
    };
    versiones.versiones.push(resumen);
    this.persistir(entrada.proyectoId, versiones);
    return resumen;
  }

  async listar(proyectoId: string): Promise<VersionResumen[]> {
    const versiones = await this.cargar(proyectoId);
    return [...versiones.versiones].sort(compararOrden);
  }

  async obtener(proyectoId: string, versionId: string): Promise<Version | null> {
    const versiones = await this.cargar(proyectoId);
    const resumen = versiones.versiones.find((v) => v.id === versionId);
    if (!resumen) return null;
    try {
      const estado = new Uint8Array(await readFile(this.rutaEstado(versionId)));
      return { ...resumen, estado };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async borrarProyecto(proyectoId: string): Promise<void> {
    const versiones = await this.cargar(proyectoId);
    for (const version of versiones.versiones) {
      await rm(this.rutaEstado(version.id), { force: true });
    }
    this.cache.delete(proyectoId);
    await this.flush();
    await rm(this.rutaIndice(proyectoId), { force: true });
  }
}
