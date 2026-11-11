import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * Formato de los mensajes del canal colaborativo.
 *
 * Vive en `shared` porque cliente y servidor tienen que estar de acuerdo byte a
 * byte. Cuando cada lado tenía su copia de las constantes, nada impedía cambiar
 * una y no la otra: el resultado no habría sido un error de compilación sino un
 * documento que deja de sincronizar en producción, que es mucho peor.
 *
 * Es el protocolo de `y-websocket`, escrito aquí en lugar de importado porque el
 * servidor necesita poder *rechazar* mensajes según el permiso del usuario y el
 * servidor de referencia aplica todo lo que le llega (RNF-SEG-04).
 *
 * Formato: [varUint tipo][carga]
 *   tipo 0 → sincronización del documento
 *   tipo 1 → presencia (awareness)
 *   tipo 2 → aviso de chat del Modo IA, sin carga (ver `encodeChatPing`)
 */

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_CHAT = 2;

/** Subtipos dentro de un mensaje de sincronización. */
export const SYNC_STEP_1 = 0;
export const SYNC_STEP_2 = 1;
export const SYNC_UPDATE = 2;

/** «Este es mi estado, mándame lo que me falte». */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwareness(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

/**
 * «Algo cambió en el Modo IA, vuelve a pedir el historial».
 *
 * Sin carga a propósito: lo que de verdad hace falta mandar —el turno nuevo,
 * con su `creadoEn` tal cual quedó en el almacén— ya tiene un camino propio y
 * probado, el que usa `ModoIA.tsx` al montarse y cada `INTERVALO_SONDEO_MS`
 * (`api.obtenerHistorialAsistente`). Duplicar ese contenido aquí abriría una
 * segunda fuente de verdad que podría desincronizarse de la primera —por
 * ejemplo, si el aviso llega antes de que la escritura en disco termine—. Este
 * mensaje solo adelanta el próximo sondeo; quien ya sondea cada pocos segundos
 * simplemente deja de esperar.
 */
export function encodeChatPing(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CHAT);
  return encoding.toUint8Array(encoder);
}

/**
 * ¿Esta actualización no cambia nada?
 *
 * Se comprueba decodificándola y no por su longitud: la codificación de un
 * documento sin novedades depende de la versión de Yjs, y una prueba de tamaño
 * se rompería en silencio al actualizar la dependencia, además del lado
 * permisivo.
 */
export function isEmptyUpdate(update: Uint8Array): boolean {
  try {
    const { structs, ds } = Y.decodeUpdate(update);
    return structs.length === 0 && ds.clients.size === 0;
  } catch {
    return false;
  }
}

export interface IncomingSync {
  kind: 'sync';
  /**
   * Decodificador posicionado justo *antes* del subtipo.
   *
   * Se deja sin consumir a propósito. `readSyncMessage` de y-protocols espera
   * leerlo él mismo, y si la cabecera se adelantara a hacerlo habría que
   * rebobinar el decodificador para dárselo —un cálculo de cuántos bytes ocupa
   * un varUint ya leído, que es exactamente el tipo de detalle del formato que
   * este módulo existe para no repartir por ahí.
   */
  decoder: decoding.Decoder;
}

export interface IncomingAwareness {
  kind: 'awareness';
  payload: Uint8Array;
}

export interface IncomingChat {
  kind: 'chat';
}

export type Incoming = IncomingSync | IncomingAwareness | IncomingChat | { kind: 'ilegible' };

/** Lee la cabecera de un mensaje y deja el resto listo para interpretar. */
export function readEnvelope(message: Uint8Array): Incoming {
  try {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_AWARENESS) {
      return { kind: 'awareness', payload: decoding.readVarUint8Array(decoder) };
    }
    if (messageType === MESSAGE_CHAT) return { kind: 'chat' };
    if (messageType !== MESSAGE_SYNC) return { kind: 'ilegible' };

    return { kind: 'sync', decoder };
  } catch {
    return { kind: 'ilegible' };
  }
}
