import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { removeAwarenessStates } from 'y-protocols/awareness';
import type { Config } from '../config.js';
import type { IdentityProvider, UserProfile } from '../auth/identity.js';
import { roleAllows, type ProjectStore } from '../storage/store.js';
import { isValidRoomId, RoomManager, type Room, type RoomConnection } from './rooms.js';
import { encodeAwareness, encodeSyncStep1, encodeUpdate, handleMessage } from './protocol.js';
import type { VigilanteDiagrama } from '../ai/vigilancia.js';

/**
 * Servidor de colaboración en tiempo real.
 *
 * La autorización ocurre dos veces y no es redundante: al abrir la conexión se
 * comprueba que el usuario pertenece al proyecto, y en cada mensaje se comprueba
 * que su permiso admite escribir. Lo primero no basta —un usuario puede ser
 * degradado a solo lectura con el socket abierto— y lo segundo solo no basta
 * porque hay que rechazar la conexión antes de cargar el documento en memoria.
 */

interface ConnectionState extends RoomConnection {
  socket: WebSocket;
  room: Room;
  alive: boolean;
  /** Instante en que se consultó el permiso por última vez. */
  roleCheckedAt: number;
  /**
   * Identificadores de presencia que ha anunciado esta conexión.
   *
   * Hay que saberlos para poder retirarlos al desconectar. Son los del `Y.Doc`
   * del navegador, que el servidor no puede deducir: no tienen relación con el
   * identificador del documento del servidor ni con el del usuario, y una misma
   * persona con dos pestañas abiertas tiene dos.
   */
  awarenessIds: Set<number>;
}

/**
 * Cuánto se reutiliza el permiso ya consultado.
 *
 * Consultarlo en cada mensaje multiplicaría por el ritmo de tecleo un trabajo
 * que casi nunca cambia de respuesta; no consultarlo nunca es el defecto que
 * esta constante existe para evitar. Dos segundos acotan la ventana en la que
 * alguien recién degradado puede seguir escribiendo, y esa ventana se cierra
 * además desde el otro lado: quitar a un miembro corta su conexión al instante.
 */
const PERMISSION_TTL_MS = 2000;

export interface CollabServerDeps {
  config: Config;
  identity: IdentityProvider;
  store: ProjectStore;
  rooms: RoomManager;
  /** Opcional para que las pruebas que no necesitan vigilar nada no tengan que construir uno. */
  vigilante?: VigilanteDiagrama;
}

export class CollabServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<ConnectionState>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CollabServerDeps) {}

  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });

    // Un socket que se cae sin cerrar (túnel, portátil suspendido) deja al
    // usuario visible como presente para todos los demás. El ping lo detecta.
    this.heartbeat = setInterval(() => this.pingAll(), 30_000);
    this.heartbeat.unref?.();
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const rejected = (status: number, message: string): void => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/colaboracion') {
        rejected(404, 'Not Found');
        return;
      }

      const projectId = url.searchParams.get('proyecto') ?? '';
      const token = url.searchParams.get('token') ?? '';

      if (!isValidRoomId(projectId)) {
        rejected(400, 'Bad Request');
        return;
      }

      const user = await this.deps.identity.verify(token);
      if (!user) {
        rejected(401, 'Unauthorized');
        return;
      }

      const role = await this.deps.store.roleOf(projectId, user.id);
      if (!roleAllows(role, 'viewer')) {
        rejected(403, 'Forbidden');
        return;
      }

      const canWrite = roleAllows(role, 'editor');
      const room = await this.deps.rooms.open(projectId);
      // Se llama en cada conexión y no solo la primera: la guarda está dentro
      // del propio vigilante (`WeakSet<Room>`), que es quien sabe si esta sala
      // concreta ya tiene oyente o es una sala nueva que sustituye a una
      // destruida. Repetir la llamada aquí es más simple que llevar esa misma
      // cuenta por duplicado en este fichero.
      this.deps.vigilante?.observar(projectId, room);

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.register(ws, room, user, canWrite);
      });
    } catch (error) {
      console.error('Fallo al negociar la conexión colaborativa:', error);
      rejected(500, 'Internal Server Error');
    }
  }

  private register(socket: WebSocket, room: Room, user: UserProfile, canWrite: boolean): void {
    const connection: ConnectionState = {
      socket,
      room,
      alive: true,
      userId: user.id,
      canWrite,
      roleCheckedAt: Date.now(),
      awarenessIds: new Set<number>(),
      send: (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      },
      close: (code, reason) => socket.close(code, reason),
    };

    room.connections.add(connection);
    this.connections.add(connection);

    const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
      // No se devuelve el cambio a quien lo originó: ya lo tiene aplicado.
      if (origin === connection) return;
      connection.send(encodeUpdate(update));
    };
    room.doc.on('update', onDocUpdate);

    const onAwarenessChange = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === connection) {
        // Es la presencia de este mismo cliente. No se le devuelve, pero sí se
        // anota de quién es: al cerrar hay que poder retirar sus cursores de la
        // pantalla de los demás, y este es el único momento en que el servidor
        // llega a saber qué identificadores usa.
        for (const id of changes.added) connection.awarenessIds.add(id);
        for (const id of changes.updated) connection.awarenessIds.add(id);
        for (const id of changes.removed) connection.awarenessIds.delete(id);
        return;
      }
      const clients = [...changes.added, ...changes.updated, ...changes.removed];
      if (clients.length === 0) return;
      connection.send(encodeAwareness(room.awareness, clients));
    };
    room.awareness.on('update', onAwarenessChange);

    socket.on('message', (data: Buffer) => {
      void this.onMessage(connection, data);
    });

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('close', () => {
      room.doc.off('update', onDocUpdate);
      room.awareness.off('update', onAwarenessChange);
      room.connections.delete(connection);
      this.connections.delete(connection);

      // Se retiran los cursores de quien se ha ido. Antes se pasaba aquí el
      // `clientID` del documento del servidor, que no es de nadie: el efecto era
      // que nunca se borraba nada y los demás seguían viendo el cursor de una
      // persona que había cerrado la pestaña, congelado en su última posición.
      if (connection.awarenessIds.size > 0) {
        removeAwarenessStates(room.awareness, [...connection.awarenessIds], null);
      }

      void this.deps.rooms.closeIfEmpty(room.id);
    });

    socket.on('error', (error) => {
      console.warn(`Error en el socket de ${user.id}:`, error.message);
    });

    // El servidor abre la sincronización. Si esperase al cliente, un cliente que
    // acaba de reconectarse y cree estar al día nunca le entregaría el trabajo
    // que hizo offline.
    //
    // Esto es solo la mitad: este paso 1 hace que el *servidor* reciba lo que le
    // falta. Para recibir a su vez, el cliente tiene que mandar su propio paso 1
    // al conectarse; el protocolo es simétrico y cada lado pide su parte.
    connection.send(encodeSyncStep1(room.doc));

    const states = [...room.awareness.getStates().keys()];
    if (states.length > 0) {
      connection.send(encodeAwareness(room.awareness, states));
    }
  }

  /**
   * Revalida el permiso si la última consulta ya no sirve.
   *
   * Devuelve `false` si el usuario ha dejado de ser miembro, en cuyo caso la
   * conexión ya no debe ni leer.
   */
  private async stillAllowed(connection: ConnectionState): Promise<boolean> {
    if (Date.now() - connection.roleCheckedAt < PERMISSION_TTL_MS) return true;

    const role = await this.deps.store.roleOf(connection.room.id, connection.userId);
    connection.roleCheckedAt = Date.now();
    connection.canWrite = roleAllows(role, 'editor');
    return roleAllows(role, 'viewer');
  }

  private async onMessage(connection: ConnectionState, data: Buffer): Promise<void> {
    const { room } = connection;

    if (data.byteLength > this.deps.config.maxMessageBytes) {
      connection.close(1009, 'Mensaje demasiado grande');
      return;
    }

    // El permiso se comprueba aquí y no solo al abrir la conexión: a un usuario
    // se le puede retirar el acceso mientras tiene el diagrama abierto, y sin
    // esto seguiría escribiendo hasta que cerrase la pestaña.
    if (!(await this.stillAllowed(connection))) {
      connection.close(1008, 'Ya no tienes acceso a este proyecto');
      return;
    }

    const result = handleMessage(new Uint8Array(data), {
      doc: room.doc,
      awareness: room.awareness,
      canWrite: connection.canWrite,
      origin: connection,
    });

    if (result.kind === 'reply') {
      connection.send(result.payload);
    } else if (result.kind === 'broadcast') {
      room.broadcast(result.payload, connection);
    } else if (result.kind === 'rejected') {
      // No se cierra la conexión: un cliente de solo lectura con una pestaña
      // vieja seguirá intentando escribir y debe poder seguir leyendo.
      console.warn(
        `Mensaje rechazado en la sala ${room.id} del usuario ${connection.userId}: ${result.reason}`,
      );
    }
  }

  private pingAll(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const connection of this.connections) {
      connection.close(1001, 'Servidor apagándose');
    }
    this.connections.clear();
    this.wss.close();
  }

  /** Número de conexiones abiertas. Lo usan el endpoint de salud y las pruebas. */
  get connectionCount(): number {
    return this.connections.size;
  }
}
