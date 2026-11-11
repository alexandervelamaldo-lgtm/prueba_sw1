import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  MESSAGE_SYNC,
  SYNC_STEP_1,
  SYNC_STEP_2,
  SYNC_UPDATE,
  isEmptyUpdate,
  readEnvelope,
} from '@app/shared';

/**
 * Decisión sobre cada mensaje entrante del canal colaborativo.
 *
 * El formato de los bytes vive en `shared/src/crdt/wire.ts`, junto al cliente
 * que los escribe. Lo que vive aquí es lo que el cliente no puede decidir: si
 * quien manda tiene permiso para que su mensaje llegue a cambiar el documento.
 *
 * Por eso el protocolo de `y-websocket` está reimplementado en vez de
 * importado. El servidor de referencia aplica todo lo que le llega; sin este
 * control, un usuario con permiso de solo lectura escribiría en el documento
 * sencillamente enviando una actualización por el socket (RNF-SEG-04).
 */

export { encodeAwareness, encodeSyncStep1, encodeUpdate } from '@app/shared';

export type HandleResult =
  | { kind: 'reply'; payload: Uint8Array }
  | { kind: 'broadcast'; payload: Uint8Array }
  | { kind: 'ignored'; reason: string }
  | { kind: 'rejected'; reason: string };

export interface HandleContext {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Falso para un usuario con permiso de solo lectura. */
  canWrite: boolean;
  /** Origen de la transacción: permite no reenviar el cambio a quien lo mandó. */
  origin: unknown;
}

/**
 * Procesa un mensaje entrante y dice qué hacer con él.
 *
 * Devuelve la decisión en lugar de ejecutarla para que la autorización sea
 * comprobable sin abrir un socket.
 */
export function handleMessage(message: Uint8Array, context: HandleContext): HandleResult {
  const sobre = readEnvelope(message);

  if (sobre.kind === 'ilegible') {
    return { kind: 'rejected', reason: 'mensaje ilegible' };
  }

  if (sobre.kind === 'awareness') {
    // La presencia es efímera y no forma parte del documento: un usuario de solo
    // lectura sí puede anunciar dónde tiene el cursor.
    try {
      awarenessProtocol.applyAwarenessUpdate(context.awareness, sobre.payload, context.origin);
    } catch {
      return { kind: 'rejected', reason: 'presencia ilegible' };
    }
    return { kind: 'broadcast', payload: message };
  }

  if (sobre.kind === 'chat') {
    // El aviso de chat lo manda el servidor cuando guarda un turno o un
    // comentario espontáneo (`api/assistant.ts`, `ai/vigilancia.ts`); ningún
    // cliente tiene razón legítima para mandarlo él mismo.
    return { kind: 'rejected', reason: 'aviso de chat solo lo manda el servidor' };
  }

  const { decoder } = sobre;

  let syncType: number;
  try {
    syncType = decoding.readVarUint(decoder);
  } catch {
    return { kind: 'rejected', reason: 'sincronización ilegible' };
  }

  if (syncType === SYNC_STEP_1) {
    // Petición de lectura: el cliente dice qué tiene y el servidor le manda lo
    // que le falta. Permitida siempre.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    try {
      syncProtocol.readSyncStep1(decoder, encoder, context.doc);
    } catch {
      return { kind: 'rejected', reason: 'paso 1 de sincronización mal formado' };
    }
    return { kind: 'reply', payload: encoding.toUint8Array(encoder) };
  }

  if (syncType === SYNC_STEP_2 || syncType === SYNC_UPDATE) {
    let update: Uint8Array;
    try {
      update = decoding.readVarUint8Array(decoder);
    } catch {
      return { kind: 'rejected', reason: 'actualización mal formada' };
    }

    if (!context.canWrite) {
      // Un cliente de solo lectura contesta igualmente al paso 1 con un paso 2,
      // porque el protocolo es simétrico y él no sabe qué permiso tiene. Ese
      // mensaje no lleva nada: rechazarlo llenaría el registro de avisos en cada
      // conexión y enterraría los intentos de escritura reales, que son los que
      // interesa ver. Se distingue por el contenido, no por la intención.
      if (isEmptyUpdate(update)) {
        return { kind: 'ignored', reason: 'paso 2 vacío de un cliente de solo lectura' };
      }
      return { kind: 'rejected', reason: 'permiso de solo lectura' };
    }

    try {
      Y.applyUpdate(context.doc, update, context.origin);
    } catch {
      return { kind: 'rejected', reason: 'actualización mal formada' };
    }
    // No se reenvía este mensaje: el propio `doc.on('update')` produce el que se
    // difunde, ya normalizado y sin la parte que el servidor ya tenía.
    return { kind: 'ignored', reason: 'aplicada; la difusión la dispara el documento' };
  }

  return { kind: 'rejected', reason: `subtipo de sincronización desconocido: ${syncType}` };
}
