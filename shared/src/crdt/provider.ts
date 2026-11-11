import * as encoding from 'lib0/encoding';
import { ObservableV2 } from 'lib0/observable';
import * as syncProtocol from 'y-protocols/sync';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  MESSAGE_SYNC,
  SYNC_STEP_2,
  encodeAwareness,
  encodeSyncStep1,
  encodeUpdate,
  readEnvelope,
} from './wire.js';

/**
 * Cliente del canal colaborativo.
 *
 * Está en `shared` y no en el frontend por dos motivos. El primero es que las
 * pruebas de integración del servidor lo usan tal cual: lo que se demuestra que
 * sincroniza es el mismo código que corre en el navegador, no una imitación
 * escrita para la prueba. El segundo es que el protocolo tiene dos lados y
 * tenerlos en el mismo repositorio, uno al lado del otro, es lo que impide que
 * se separen sin que nadie se entere.
 *
 * Lo que este objeto NO hace es igual de importante: no interpreta el diagrama.
 * Solo mueve actualizaciones. Quien decide qué es una clase válida es
 * `operations.ts`, y así el servidor puede seguir siendo un participante tonto
 * con disco (decisión D1).
 */

export type EstadoConexion = 'conectando' | 'conectado' | 'desconectado' | 'sin-permiso';

/**
 * Lo que este cliente necesita de un WebSocket, y nada más.
 *
 * No se usa el tipo `WebSocket` del navegador porque obligaría a compilar
 * `shared` con la librería DOM, y entonces `document` y `window` pasarían a
 * existir para todo el paquete —incluido el código que el servidor importa, que
 * es donde usarlos falla en producción y no en la compilación.
 *
 * Con esta interfaz encajan las dos implementaciones sin adaptador: la global
 * del navegador y la de «ws» en Node. Los eventos se piden por
 * `addEventListener` en vez de por las propiedades `onmessage`: las propiedades
 * se comparan de forma contravariante y ninguna de las dos implementaciones
 * pasaría la comprobación.
 */
export interface MensajeEntrante {
  data: unknown;
}

export interface CierreEntrante {
  code: number;
  reason: string;
}

export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(tipo: 'open', escucha: () => void): void;
  addEventListener(tipo: 'message', escucha: (evento: MensajeEntrante) => void): void;
  addEventListener(tipo: 'close', escucha: (evento: CierreEntrante) => void): void;
  addEventListener(tipo: 'error', escucha: () => void): void;
}

export type SocketFactory = new (url: string) => SocketLike;

export interface CollabProviderOptions {
  url: string;
  doc: Y.Doc;
  /**
   * Implementación de WebSocket. El navegador tiene la suya global; en Node hay
   * que inyectar la de `ws`. Se pide en lugar de detectarla para que el fallo,
   * si falta, sea inmediato y explícito.
   */
  WebSocketImpl?: SocketFactory;
  awareness?: Awareness;
  /** Se llama en cada cambio de estado; es lo que pinta el indicador de sync. */
  onEstado?: (estado: EstadoConexion, detalle?: string) => void;
  /** Se llama cuando el documento termina de ponerse al día con el servidor. */
  onSincronizado?: () => void;
  /** Reintento inicial en milisegundos. Crece hasta `maxReintentoMs`. */
  reintentoMs?: number;
  maxReintentoMs?: number;
}

/** Códigos de cierre que no tiene sentido reintentar. */
const CIERRES_DEFINITIVOS = new Set([
  1008, // política violada: token inválido o acceso retirado
  4001,
]);

/** El único valor de `readyState` en el que se puede enviar. */
const ABIERTO = 1;

/** Eventos propios del proveedor, más allá de los de `doc` y `awareness`. */
interface EventosProvider {
  /** Algo cambió en el hilo del Modo IA del proyecto: vuelve a pedir el historial. */
  chat: () => void;
}

export class CollabProvider extends ObservableV2<EventosProvider> {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private socket: SocketLike | null = null;
  private readonly WebSocketImpl: SocketFactory;
  private readonly url: string;
  private readonly onEstado: (estado: EstadoConexion, detalle?: string) => void;
  private readonly onSincronizado: () => void;
  private readonly reintentoBase: number;
  private readonly reintentoMax: number;

  private estadoActual: EstadoConexion = 'desconectado';
  private intentos = 0;
  private reintentoTimer: ReturnType<typeof setTimeout> | null = null;
  private cerradoAdrede = false;
  private sincronizado = false;

  /**
   * Qué intento de conexión es el bueno.
   *
   * Sube en cada `conectar()`, y cada juego de escuchas se queda con el número
   * que había cuando se registró. Hace falta porque `reconectarYa` abandona un
   * socket que puede seguir vivo, y el `close` de ese socket llega **después**
   * de que el nuevo esté abierto: sin este contador, la escucha del viejo
   * pondría `this.socket = null` —dejando mudo al nuevo, que ya estaba
   * asignado— y programaría un reintento, con lo que acabarían corriendo dos
   * conexiones a la vez. El síntoma sería un diagrama que duplica lo que se
   * escribe, y cuesta días encontrarlo.
   */
  private generacion = 0;

  constructor(options: CollabProviderOptions) {
    super();
    this.doc = options.doc;
    this.url = options.url;
    this.awareness = options.awareness ?? new Awareness(options.doc);
    this.onEstado = options.onEstado ?? ((): void => {});
    this.onSincronizado = options.onSincronizado ?? ((): void => {});
    this.reintentoBase = options.reintentoMs ?? 500;
    this.reintentoMax = options.maxReintentoMs ?? 15_000;

    const impl =
      options.WebSocketImpl ?? (globalThis as { WebSocket?: SocketFactory }).WebSocket;
    if (!impl) {
      throw new Error(
        'No hay implementación de WebSocket disponible. En Node hay que pasar la de «ws».',
      );
    }
    this.WebSocketImpl = impl;

    this.doc.on('update', this.enviarCambioLocal);
    this.awareness.on('update', this.enviarPresenciaLocal);
    this.conectar();
  }

  // -------------------------------------------------------------------------
  // Salida
  // -------------------------------------------------------------------------

  /**
   * Reenvía al servidor lo que se ha editado aquí.
   *
   * El origen distingue lo que viene del socket de lo que hace el usuario. Sin
   * esa comprobación cada mensaje recibido se devolvería al servidor y el eco no
   * terminaría nunca.
   */
  private enviarCambioLocal = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    this.enviar(encodeUpdate(update));
  };

  private enviarPresenciaLocal = (
    cambios: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    const clientes = [...cambios.added, ...cambios.updated, ...cambios.removed];
    if (clientes.length === 0) return;
    this.enviar(encodeAwareness(this.awareness, clientes));
  };

  /**
   * Manda si hay conexión y descarta si no.
   *
   * No se encola lo que no cabe enviar: al reconectar, la sincronización manda
   * el estado completo, así que una cola solo serviría para reenviar cambios que
   * el otro extremo va a recibir igualmente. Es la propiedad del CRDT que hace
   * innecesaria la mitad del código que suele acompañar a un WebSocket.
   */
  private enviar(payload: Uint8Array): void {
    if (this.socket?.readyState === ABIERTO) this.socket.send(payload);
  }

  // -------------------------------------------------------------------------
  // Conexión
  // -------------------------------------------------------------------------

  private conectar(): void {
    if (this.cerradoAdrede) return;

    this.generacion += 1;
    const generacion = this.generacion;
    /** ¿Sigue siendo este el socket bueno, o ya se abandonó por otro? */
    const vigente = (): boolean => generacion === this.generacion && !this.cerradoAdrede;

    this.cambiarEstado('conectando');
    const socket = new this.WebSocketImpl(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', (): void => {
      if (!vigente()) {
        // Se abrió tarde, cuando ya se había decidido tirarlo. Dejarlo abierto
        // sería una conexión huérfana consumiendo un hueco en el servidor
        // durante toda la sesión.
        socket.close();
        return;
      }
      this.intentos = 0;
      this.cambiarEstado('conectado');

      // El cliente pide lo suyo. El paso 1 que envía el servidor solo consigue
      // que el servidor reciba: la sincronización es simétrica y cada lado tiene
      // que pedir su mitad.
      this.enviar(encodeSyncStep1(this.doc));

      // Y se anuncia, para que los demás lo vean aparecer en el lienzo.
      if (this.awareness.getLocalState() !== null) {
        this.enviar(encodeAwareness(this.awareness, [this.doc.clientID]));
      }
    });

    socket.addEventListener('message', (evento: MensajeEntrante): void => {
      if (!vigente()) return;
      const bytes = aBytes(evento.data);
      if (bytes) this.recibir(bytes);
    });

    socket.addEventListener('close', (evento: CierreEntrante): void => {
      // El adiós de un socket abandonado no dice nada de la conexión actual, y
      // atenderlo la rompería: ver `generacion`.
      if (!vigente()) return;
      this.socket = null;
      this.sincronizado = false;

      // Los demás dejan de estar presentes: sus cursores tienen que
      // desaparecer, no quedarse congelados en la última posición conocida.
      const ajenos = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      if (ajenos.length > 0) removeAwarenessStates(this.awareness, ajenos, this);

      if (this.cerradoAdrede) return;

      if (CIERRES_DEFINITIVOS.has(evento.code)) {
        // Reintentar aquí sería una espera infinita con un mensaje engañoso: el
        // servidor no ha fallado, es que este usuario ya no tiene acceso.
        this.cambiarEstado('sin-permiso', evento.reason || 'No tienes acceso a este proyecto');
        return;
      }

      this.cambiarEstado('desconectado', evento.reason);
      this.programarReintento();
    });

    socket.addEventListener('error', (): void => {
      // No se hace nada aquí: el evento de cierre siempre llega después y es el
      // único sitio donde se decide reintentar. Duplicarlo provocaría dos
      // reconexiones simultáneas por cada caída.
    });
  }

  private programarReintento(): void {
    if (this.reintentoTimer !== null) return;

    // Espera creciente con algo de azar: si se cae el servidor con cien
    // pestañas abiertas, todas reintentarían a la vez y lo tumbarían otra vez
    // justo al levantarse.
    const espera = Math.min(this.reintentoBase * 2 ** this.intentos, this.reintentoMax);
    const conRuido = espera * (0.5 + Math.random() * 0.5);
    this.intentos += 1;

    this.reintentoTimer = setTimeout(() => {
      this.reintentoTimer = null;
      this.conectar();
    }, conRuido);
  }

  private recibir(message: Uint8Array): void {
    const sobre = readEnvelope(message);

    if (sobre.kind === 'ilegible') return;
    if (sobre.kind === 'awareness') {
      applyAwarenessUpdate(this.awareness, sobre.payload, this);
      return;
    }
    if (sobre.kind === 'chat') {
      this.emit('chat', []);
      return;
    }

    // `readSyncMessage` lee el subtipo del decodificador y escribe la respuesta
    // entera en el codificador, subtipo incluido. Solo hay que darle la cabecera
    // ya puesta.
    const respuesta = encoding.createEncoder();
    encoding.writeVarUint(respuesta, MESSAGE_SYNC);
    let tipo: number;
    try {
      tipo = syncProtocol.readSyncMessage(sobre.decoder, respuesta, this.doc, this);
    } catch {
      // Un mensaje corrupto no debe tumbar la sesión: el siguiente paso 1 de
      // cualquiera de los dos lados vuelve a poner los documentos de acuerdo.
      return;
    }

    // Solo se contesta si hubo algo que contestar: el byte del tipo está
    // siempre, así que la longitud es lo que distingue una respuesta de nada.
    if (encoding.length(respuesta) > 1) this.enviar(encoding.toUint8Array(respuesta));

    // El paso 2 es el que trae lo que faltaba. Hasta recibirlo el documento
    // puede estar vacío, y pintar «sincronizado» antes sería mentir justo en el
    // momento en que el usuario mira el indicador.
    if (!this.sincronizado && tipo === SYNC_STEP_2) {
      this.sincronizado = true;
      this.cambiarEstado('conectado');
      this.onSincronizado();
    }
  }

  private cambiarEstado(estado: EstadoConexion, detalle?: string): void {
    if (estado === this.estadoActual && estado !== 'conectado') return;
    this.estadoActual = estado;
    this.onEstado(estado, detalle);
  }

  get estado(): EstadoConexion {
    return this.estadoActual;
  }

  /** ¿Ha llegado ya el contenido que el servidor tenía y este cliente no? */
  get estaSincronizado(): boolean {
    return this.sincronizado;
  }

  /**
   * Tira la conexión actual y abre otra ahora mismo.
   *
   * Es lo único que salva del socket medio muerto: el que Android dejó atrás al
   * congelar el WebView, o el que quedó atado a la dirección IP de la wifi
   * cuando el teléfono saltó a datos. En los dos casos no llega ningún `close`
   * —no hay nadie a quien mandárselo— y `readyState` sigue diciendo `OPEN`, con
   * lo que el proveedor envía a la nada y el indicador afirma «Al día». La
   * espera creciente no ayuda porque solo corre después de un cierre, y aquí no
   * lo hay.
   *
   * Por eso **no se mira el estado antes de cerrar**. Mirarlo sería preguntarle
   * a la única fuente que no puede saber la respuesta. Quien decide si vale la
   * pena pagar la reconexión es `alDespertar` en el frontend, con lo que sí se
   * sabe: cuánto tiempo estuvo el aparato sin correr y si cambió la red.
   *
   * A los demás no se les quita la presencia al pasar por aquí. La nueva
   * conexión los volverá a anunciar en cuanto sincronice, y quien se haya
   * marchado de verdad se cae solo por inactividad; borrarlos aquí haría que
   * las fichas de la barra desaparecieran y volvieran a aparecer en cada
   * desbloqueo de pantalla.
   */
  reconectarYa(): void {
    if (this.cerradoAdrede) return;

    if (this.reintentoTimer !== null) {
      clearTimeout(this.reintentoTimer);
      this.reintentoTimer = null;
    }
    // La cuenta de intentos vuelve a cero: la espera creciente protege al
    // servidor de cien pestañas reintentando en bucle, no de una persona que
    // acaba de desbloquear el teléfono y está mirando la pantalla.
    this.intentos = 0;
    this.sincronizado = false;

    const abandonado = this.socket;
    this.socket = null;
    // Se invalida antes de cerrar, no después: algunas implementaciones emiten
    // el `close` de forma síncrona dentro de `close()`, y para entonces la
    // escucha vieja ya tiene que estar desautorizada.
    this.generacion += 1;
    abandonado?.close();

    this.conectar();
  }

  /** Cierra sin reintentar. Es lo que hay que llamar al salir del diagrama. */
  override destroy(): void {
    this.cerradoAdrede = true;
    if (this.reintentoTimer !== null) clearTimeout(this.reintentoTimer);
    this.doc.off('update', this.enviarCambioLocal);
    this.awareness.off('update', this.enviarPresenciaLocal);
    this.awareness.destroy();
    this.socket?.close();
    this.socket = null;
    super.destroy();
  }
}

/**
 * Normaliza la carga del evento a bytes.
 *
 * Se pide `binaryType = 'arraybuffer'`, pero la implementación de Node entrega
 * un `Buffer` de todos modos en algunos caminos. Aceptar las dos formas cuesta
 * dos líneas; asumir una sola se manifiesta como un documento que no sincroniza
 * en un entorno y sí en el otro.
 */
function aBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}
