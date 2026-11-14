/**
 * El modelo local, cuando lo hay.
 *
 * Ollama corre en la máquina de quien usa la aplicación, no en el servidor. La
 * llamada sale del navegador hacia `http://localhost:11434` y no pasa por el
 * backend, y no puede ser de otro modo: si la aplicación está desplegada en la
 * nube, el servidor está en otra máquina y su «localhost» no es el del usuario.
 *
 * Dos cosas que hay que saber para que esto funcione:
 *
 *   - **Contenido mixto.** Una página servida por HTTPS no puede llamar a HTTP…
 *     salvo a `localhost` y `127.0.0.1`, que Chrome, Edge y Firefox tratan como
 *     orígenes potencialmente seguros justo para este caso. Safari es más
 *     estricto y ahí esto no va a funcionar.
 *   - **CORS.** Ollama rechaza por defecto las peticiones que vienen de un
 *     origen que no sea local. Para usarlo desde el dominio desplegado hay que
 *     arrancarlo con `OLLAMA_ORIGINS=https://tu-dominio`. En `localhost:5173`
 *     funciona sin tocar nada.
 *
 * Y una que hay que asumir: **esto no va a existir en el móvil.** Ollama no
 * corre en un teléfono. Por eso nada de este módulo es obligatorio para que la
 * ayuda funcione: si no hay modelo, la guía responde con la búsqueda del manual,
 * que es la ruta que sí funciona en todas partes.
 */

import {
  buscar,
  comoContexto,
  NO_CUBIERTO,
  SISTEMA_GUIA,
  type Indice,
  type Resultado,
} from '@app/shared';

export const OLLAMA_POR_DEFECTO = 'http://localhost:11434';

/** El modelo pequeño que se recomienda: entra en 8 GB de RAM y habla español. */
export const MODELO_POR_DEFECTO = 'llama3.2:3b';

const CLAVE_URL = 'ollama-url:v1';

/**
 * La URL de Ollama, cuando no es la de esta máquina.
 *
 * El valor por defecto sirve cuando quien pregunta y quien tiene el modelo son
 * el mismo equipo. Quien enseña la versión desplegada en AWS desde **otro**
 * dispositivo —un móvil en la misma sala, por ejemplo— no tiene eso: el modelo
 * sigue en el portátil de quien lo instaló, y lo único que lo alcanza es un
 * túnel (`ngrok http 11434`) que da una URL `https://algo.ngrok-free.app`. Esa
 * URL cambia cada vez que se reinicia el túnel, así que no puede ir escrita en
 * el código: se guarda donde ya se guardan las demás preferencias que no son
 * de servidor ([`useTema`](../hooks/useTema.ts)).
 *
 * El CORS lo sigue decidiendo `OLLAMA_ORIGINS` contra el origen de la **página**
 * (el dominio de AWS), no contra el del túnel: ngrok solo transporta la
 * petición, no cambia quién la hizo.
 */
function leerUrlGuardada(): string | null {
  try {
    return window.localStorage.getItem(CLAVE_URL);
  } catch {
    // Sin sitio o sin permiso —navegación privada de Safari, por ejemplo—: se
    // sigue con el valor por defecto en vez de romper la guía por esto.
    return null;
  }
}

/** La URL que hay que usar hoy: la guardada, o `localhost` si no hay ninguna. */
export function urlOllama(): string {
  return leerUrlGuardada() ?? OLLAMA_POR_DEFECTO;
}

/** Guarda la URL, o la borra con `null`/vacío para volver a `localhost`. */
export function guardarUrlOllama(url: string | null): void {
  try {
    const limpia = url?.trim();
    if (!limpia) {
      window.localStorage.removeItem(CLAVE_URL);
    } else {
      window.localStorage.setItem(CLAVE_URL, limpia);
    }
  } catch {
    /* La URL vale para esta sesión y se pedirá otra vez en la próxima. */
  }
}

// El prompt vive en `shared/src/guia/prompt.ts`, no aquí: lo comparte con el
// motor del servidor, y quien pregunta no elige cuál de los dos le contesta.

export interface RespuestaGuia {
  readonly texto: string;
  /** Las secciones que se le pasaron al modelo, para poder enseñarlas. */
  readonly fuentes: readonly Resultado[];
}

/** Un `fetch` inyectable: es lo que permite probar esto sin levantar Ollama. */
export type Fetch = typeof globalThis.fetch;

export interface OpcionesOllama {
  readonly url?: string;
  readonly modelo?: string;
  readonly fetch?: Fetch;
  /** Se llama con cada trozo según llega, para poder escribir mientras piensa. */
  readonly onTrozo?: (trozo: string) => void;
  readonly signal?: AbortSignal;
}

/**
 * ¿Hay un Ollama escuchando?
 *
 * Con un tiempo de espera corto y a propósito. Sin él, cuando no hay nada en ese
 * puerto la promesa se queda colgada hasta que el sistema operativo se rinde, y
 * el panel de ayuda aparecería en blanco durante veinte segundos antes de
 * ofrecer la búsqueda que podría haber ofrecido de inmediato.
 */
export async function modelosDisponibles(opciones: OpcionesOllama = {}): Promise<string[]> {
  const f = opciones.fetch ?? globalThis.fetch;
  const url = opciones.url ?? OLLAMA_POR_DEFECTO;
  const corte = AbortSignal.timeout(1500);

  try {
    const respuesta = await f(`${url}/api/tags`, { signal: corte });
    if (!respuesta.ok) return [];
    const cuerpo: unknown = await respuesta.json();
    const modelos = (cuerpo as { models?: { name?: unknown }[] }).models;
    if (!Array.isArray(modelos)) return [];
    return modelos.map((m) => m.name).filter((n): n is string => typeof n === 'string');
  } catch {
    // Cualquier fallo —no está, CORS, se agotó el tiempo— significa lo mismo
    // para quien llama: hoy no hay modelo. Distinguirlos aquí no cambiaría nada.
    return [];
  }
}

/**
 * Extrae el texto de una línea de la respuesta de Ollama.
 *
 * Ollama contesta NDJSON: un objeto JSON por línea, cada uno con un trozo. Se
 * separa del transporte para poder probarlo, porque es donde está la parte
 * frágil: los trozos no llegan alineados con las líneas y una línea puede venir
 * partida entre dos lecturas del socket.
 */
export function trozoDeLinea(linea: string): string | null {
  const limpia = linea.trim();
  if (limpia === '') return null;
  try {
    const objeto: unknown = JSON.parse(limpia);
    const mensaje = (objeto as { message?: { content?: unknown } }).message;
    return typeof mensaje?.content === 'string' ? mensaje.content : null;
  } catch {
    return null;
  }
}

/**
 * Pregunta al modelo con el manual delante.
 *
 * Devuelve también las secciones recuperadas, no solo el texto. Enseñarlas es lo
 * que permite comprobar la respuesta: si el modelo se desvía, la sección citada
 * está ahí al lado para contrastarla, y quien pregunta puede leer el manual sin
 * fiarse de la paráfrasis.
 */
export async function preguntar(
  indice: Indice,
  pregunta: string,
  opciones: OpcionesOllama = {},
): Promise<RespuestaGuia> {
  const f = opciones.fetch ?? globalThis.fetch;
  const url = opciones.url ?? OLLAMA_POR_DEFECTO;
  const fuentes = buscar(indice, pregunta, 4);

  // Si el manual no tiene nada que decir, no se molesta al modelo: sin contexto
  // solo puede improvisar, que es justo lo que no queremos que haga.
  if (fuentes.length === 0) {
    return { texto: NO_CUBIERTO, fuentes: [] };
  }

  const respuesta = await f(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opciones.signal ?? null,
    body: JSON.stringify({
      model: opciones.modelo ?? MODELO_POR_DEFECTO,
      stream: true,
      // Temperatura baja: de una guía se quiere la misma respuesta a la misma
      // pregunta, no variedad.
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: SISTEMA_GUIA },
        { role: 'user', content: `MANUAL:\n\n${comoContexto(fuentes)}\n\nPREGUNTA: ${pregunta}` },
      ],
    }),
  });

  if (!respuesta.ok) {
    throw new Error(`Ollama respondió ${respuesta.status}. ¿Está el modelo descargado?`);
  }
  if (respuesta.body === null) throw new Error('Ollama no devolvió ningún cuerpo.');

  const lector = respuesta.body.getReader();
  const decodificador = new TextDecoder();
  let pendiente = '';
  let texto = '';

  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    pendiente += decodificador.decode(value, { stream: true });

    // Se procesa hasta el último salto de línea y se guarda el resto: la cola
    // suele ser media línea de JSON que se completa en la lectura siguiente.
    const lineas = pendiente.split('\n');
    pendiente = lineas.pop() ?? '';
    for (const linea of lineas) {
      const trozo = trozoDeLinea(linea);
      if (trozo === null || trozo === '') continue;
      texto += trozo;
      opciones.onTrozo?.(trozo);
    }
  }

  const ultimo = trozoDeLinea(pendiente);
  if (ultimo !== null && ultimo !== '') {
    texto += ultimo;
    opciones.onTrozo?.(ultimo);
  }

  return { texto: texto.trim(), fuentes };
}
