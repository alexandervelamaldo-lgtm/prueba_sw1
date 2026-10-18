import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Cuántos tokens de la IA gastó cada usuario cada día (control de costos).
 *
 * Lo que se cuenta es lo que el proveedor informa en `usage`, o una estimación
 * cuando no lo informa (ver `estimarTokens` en `ai/assistant.ts`). Con
 * `LLM_LIMITE_DIARIO_TOKENS` configurado, las rutas del asistente dejan de
 * llamar al modelo cuando alguien llega a su límite del día; sin él, solo se
 * cuenta.
 *
 * El día es la fecha UTC (`diaDeHoy`): el servidor no sabe la zona de cada
 * usuario, y un corte a la misma hora para todos es más fácil de explicar.
 */
export interface UsoIAStore {
  /** Suma `tokens` al día y devuelve el total de ese día. */
  sumar(usuarioId: string, dia: string, tokens: number): Promise<number>;
  leer(usuarioId: string, dia: string): Promise<number>;
  close?(): Promise<void>;
}

/** La fecha UTC de hoy, `AAAA-MM-DD`. */
export function diaDeHoy(ahora = new Date()): string {
  return ahora.toISOString().slice(0, 10);
}

/** Días que se guardan por usuario: lo suficiente para mirar el último mes. */
const DIAS_GUARDADOS = 31;

/** Una cantidad que no resta ni deja decimales en el total. */
function tokensSanos(tokens: number): number {
  return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
}

type UsoEnDisco = Record<string, Record<string, number>>;

/**
 * Implementación en disco, la de desarrollo: un único fichero JSON con el uso
 * de todos los usuarios. Se escribe a un temporal y se renombra, como los
 * demás almacenes de fichero.
 */
export class FileUsoIAStore implements UsoIAStore {
  private readonly ruta: string;
  // La lectura en curso, compartida: dos peticiones que llegan antes de que
  // termine la primera carga tienen que sumar sobre el mismo objeto, o la
  // segunda en cargar pisaría lo que sumó la primera.
  private carga: Promise<UsoEnDisco> | null = null;
  private colaDeEscritura: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.ruta = join(resolve(dataDir), 'uso-ia.json');
  }

  private cargar(): Promise<UsoEnDisco> {
    this.carga ??= readFile(this.ruta, 'utf8').then(
      (texto) => JSON.parse(texto) as UsoEnDisco,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          // Un fallo de lectura no se queda guardado: la siguiente vuelve a probar.
          this.carga = null;
          throw error;
        }
        return {};
      },
    );
    return this.carga;
  }

  private persistir(datos: UsoEnDisco): void {
    this.colaDeEscritura = this.colaDeEscritura
      .then(async () => {
        await mkdir(dirname(this.ruta), { recursive: true });
        const temporal = `${this.ruta}.tmp`;
        await writeFile(temporal, JSON.stringify(datos, null, 2), 'utf8');
        await rename(temporal, this.ruta);
      })
      .catch((error: unknown) => {
        console.error('No se pudo persistir el uso de la IA:', error);
      });
  }

  /** Espera al volcado pendiente. Solo lo usan las pruebas y el apagado. */
  async flush(): Promise<void> {
    await this.colaDeEscritura;
  }

  async sumar(usuarioId: string, dia: string, tokens: number): Promise<number> {
    const datos = await this.cargar();
    const delUsuario = { ...datos[usuarioId] };
    delUsuario[dia] = (delUsuario[dia] ?? 0) + tokensSanos(tokens);
    datos[usuarioId] = delUsuario;
    // Se olvida lo anterior a los últimos `DIAS_GUARDADOS` días, de todos los
    // usuarios, para que el fichero no crezca con quien ya no usa la IA. Las
    // claves AAAA-MM-DD se comparan como texto en el mismo orden que fechas.
    const desde = new Date(`${dia}T00:00:00Z`);
    desde.setUTCDate(desde.getUTCDate() - DIAS_GUARDADOS);
    const corte = diaDeHoy(desde);
    for (const [usuario, dias] of Object.entries(datos)) {
      for (const otro of Object.keys(dias)) if (otro < corte) delete dias[otro];
      if (Object.keys(dias).length === 0) delete datos[usuario];
    }
    this.persistir(datos);
    return delUsuario[dia] ?? 0;
  }

  async leer(usuarioId: string, dia: string): Promise<number> {
    const datos = await this.cargar();
    return datos[usuarioId]?.[dia] ?? 0;
  }
}
