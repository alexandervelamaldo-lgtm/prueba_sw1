/**
 * Transporte HTTP hacia el proveedor de modelo.
 *
 * Lo comparten el asistente de texto y la lectura de tablas fotografiadas
 * porque las dos necesitan exactamente lo mismo: plazo máximo, cabecera de
 * autenticación y —sobre todo— el cuerpo del error a la vista.
 *
 * Ese último punto costó tiempo aprenderlo. Un fallo del proveedor llega como
 * un número que no distingue entre clave inválida, saldo agotado y modelo
 * inexistente; los tres devuelven 4xx y los tres se arreglan de forma distinta.
 * El texto de la respuesta sí lo explica, así que se propaga recortado.
 */

export class ErrorDeModelo extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ErrorDeModelo';
  }
}

export interface PeticionAlModelo {
  url: string;
  /** Cabeceras propias del proveedor. `content-type` ya va puesto. */
  headers: Record<string, string>;
  body: unknown;
  /** Plazo de **cada** intento, no del conjunto. */
  timeoutMs: number;
  /** Reintentos ante un fallo pasajero. 0 desactiva la reintentona. */
  reintentos?: number;
  /** Espera base entre intentos. Sale como parámetro para que las pruebas no duren minutos. */
  pausaMs?: number;
}

/** Devuelve el cuerpo SSE sin interpretar el protocolo concreto del proveedor. */
export async function* leerStreamDelModelo(
  opciones: PeticionAlModelo,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const controller = new AbortController();
  const abortar = (): void => controller.abort();
  if (signal?.aborted) throw new DOMException('La petición se canceló', 'AbortError');
  signal?.addEventListener('abort', abortar, { once: true });
  let primerByte = false;
  // El plazo cuenta hasta el primer byte y, después, entre dos trozos: un
  // proveedor que se queda callado a mitad de respuesta también se corta, en
  // vez de dejar el Modo IA esperando para siempre.
  let timer = setTimeout(() => controller.abort(), opciones.timeoutMs);

  try {
    const response = await fetch(opciones.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...opciones.headers },
      body: JSON.stringify(opciones.body),
    });
    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      throw new ErrorDeModelo(`${response.status} ${detalle.slice(0, 300)}`.trim(), response.status);
    }
    if (!response.body) throw new ErrorDeModelo('el modelo no devolvió un stream');

    const reader = response.body.getReader();
    const decodificador = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          const resto = decodificador.decode();
          if (resto) yield resto;
          return;
        }
        primerByte = true;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), opciones.timeoutMs);
        const texto = decodificador.decode(value, { stream: true });
        if (texto) yield texto;
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ErrorDeModelo(
        primerByte
          ? `el modelo dejó de responder durante ${opciones.timeoutMs} ms`
          : `el modelo no respondió en ${opciones.timeoutMs} ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortar);
  }
}

/**
 * Códigos que merecen otro intento.
 *
 * La lista es corta a propósito. `429` es cuota por minuto y `502/503/504` son
 * el proveedor saturado o reiniciándose: en los cuatro casos, lo mismo que
 * acaba de fallar funciona un segundo después. Fuera quedan `401` (clave mala),
 * `402` (sin saldo), `404` (modelo retirado) y `400` (petición mal formada),
 * que reintentar solo haría más lentos: van a fallar igual las veces que hagan
 * falta, y el usuario tiene que ir a arreglar algo.
 *
 * `500` tampoco se reintenta. En estos proveedores suele significar que el
 * modelo se atragantó con *esta* petición concreta, y además el asistente de
 * texto lo usa como señal para bajarse a la gramática local: reintentarlo
 * retrasaría esa degradación, que es justo lo que la hace útil.
 */
const PASAJEROS = new Set([429, 502, 503, 504]);

const dormir = (ms: number): Promise<void> => new Promise((listo) => setTimeout(listo, ms));

async function unIntento<T>(opciones: PeticionAlModelo): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opciones.timeoutMs);

  try {
    const response = await fetch(opciones.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...opciones.headers },
      body: JSON.stringify(opciones.body),
    });

    if (!response.ok) {
      const detalle = await response.text().catch(() => '');
      throw new ErrorDeModelo(`${response.status} ${detalle.slice(0, 300)}`.trim(), response.status);
    }

    return (await response.json()) as T;
  } catch (error) {
    // `AbortError` es lo que se ve cuando vence el plazo, y su mensaje por
    // defecto («This operation was aborted») no le dice nada a nadie.
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ErrorDeModelo(`el modelo no respondió en ${opciones.timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function pedirAlModelo<T>(opciones: PeticionAlModelo): Promise<T> {
  const reintentos = opciones.reintentos ?? 0;
  const pausa = opciones.pausaMs ?? 800;

  for (let intento = 0; ; intento += 1) {
    try {
      return await unIntento<T>(opciones);
    } catch (error) {
      const pasajero = error instanceof ErrorDeModelo && PASAJEROS.has(error.status ?? 0);
      if (!pasajero || intento >= reintentos) throw error;
      // Espera creciente: si el proveedor está saturado, volver a golpearlo al
      // mismo ritmo es parte del problema.
      await dormir(pausa * 2 ** intento);
    }
  }
}
