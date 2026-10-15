import { readDiagram } from '@app/shared';
import type { AssistantEngine } from './assistant.js';
import type { ConversationStore } from '../storage/conversaciones.js';
import type { Room } from '../collab/rooms.js';

/**
 * Hace que el Modo IA hable sin que nadie le haya preguntado nada.
 *
 * Es la otra mitad del encargo ("que hable sola"): `AssistantEngine.revisar`
 * decide *qué* decir, y esta clase decide *cuándo* vale la pena preguntárselo.
 * Entre las dos evitan los dos extremos malos —comentar en cada pulsación de
 * tecla, o no comentar nunca porque nadie llamó a `revisar` desde ningún
 * sitio.
 *
 * ## Por qué se engancha a `room.doc` y no a las rutas HTTP
 *
 * El cambio que hay que vigilar es el diagrama colaborativo, el mismo `Y.Doc`
 * que ya usa `CollabServer` para repartir las ediciones entre pestañas (ver
 * `collab/server.ts`). Engancharse ahí, y no a `/diagrama/operaciones`, es lo
 * que hace que esto vea también lo que entra por el lienzo a mano, no solo lo
 * que aplica una propuesta de la IA.
 *
 * ## Por qué `WeakSet<Room>` y no `Set<string>`
 *
 * Una sala vacía se destruye (`RoomManager.closeIfEmpty`) y, si alguien vuelve
 * a abrir el proyecto, se crea una `Room` nueva con un `Y.Doc` nuevo. Guardar
 * el id del proyecto en un `Set` dejaría la sala nueva sin oyente, porque el id
 * ya estaría marcado como "ya vigilado" de la sala anterior. Guardar la propia
 * instancia en un `WeakSet` vigila la sala concreta que existe ahora, y además
 * no hay que acordarse de limpiar nada cuando esa sala se destruye.
 */

/** Cuánto se espera, tras el último cambio, antes de mirar el diagrama. */
const ESPERA_TRAS_CAMBIO_MS = 20_000;

/**
 * Cuánto se espera entre dos comentarios espontáneos del mismo proyecto.
 *
 * Sin esto, cada ráfaga de cambios terminaría en un comentario propio: alguien
 * que está modelando a buen ritmo vería a la IA interrumpir cada veinte
 * segundos, que es el ruido que el encargo pedía evitar ("que hable sola" no
 * significa "que hable todo el rato").
 */
const ENFRIAMIENTO_MS = 5 * 60_000;

export class VigilanteDiagrama {
  private readonly observadas = new WeakSet<Room>();
  private readonly temporizadores = new WeakMap<Room, ReturnType<typeof setTimeout>>();
  private readonly ultimoComentario = new Map<string, number>();

  constructor(
    private readonly assistant: AssistantEngine,
    private readonly conversations: ConversationStore,
    private readonly esperaMs: number = ESPERA_TRAS_CAMBIO_MS,
    private readonly enfriamientoMs: number = ENFRIAMIENTO_MS,
  ) {}

  /**
   * Empieza a vigilar esta sala, si no se estaba vigilando ya.
   *
   * Se puede llamar una vez por cada conexión que se abre a la sala —lo hace
   * `CollabServer`— sin que eso duplique el oyente: la guarda es la propia
   * instancia de `Room`, no el número de llamadas.
   */
  observar(proyectoId: string, room: Room): void {
    if (this.observadas.has(room)) return;
    this.observadas.add(room);

    room.doc.on('update', () => {
      const anterior = this.temporizadores.get(room);
      if (anterior) clearTimeout(anterior);

      const temporizador = setTimeout(() => {
        this.temporizadores.delete(room);
        void this.revisar(proyectoId, room);
      }, this.esperaMs);
      // No debe ser el temporizador quien mantenga el proceso vivo.
      temporizador.unref?.();
      this.temporizadores.set(room, temporizador);
    });
  }

  private async revisar(proyectoId: string, room: Room): Promise<void> {
    // Sin nadie conectado no hay a quién hablarle: el comentario se perdería
    // hasta que alguien volviera a abrir el proyecto, y para entonces puede
    // que ya no tenga sentido.
    if (room.connections.size === 0) return;

    const ahora = Date.now();
    const anterior = this.ultimoComentario.get(proyectoId) ?? 0;
    if (ahora - anterior < this.enfriamientoMs) return;

    try {
      const diagram = readDiagram(room.doc);
      const comentario = await this.assistant.revisar(diagram);
      if (!comentario) return;

      this.ultimoComentario.set(proyectoId, ahora);
      await this.conversations.appendComentario(proyectoId, comentario);
    } catch (error) {
      // Un comentario espontáneo que falla no es una avería del proyecto: es
      // la IA quedándose callada, que es justo lo que pasa cuando no tiene
      // nada que decir.
      console.warn('El vigilante no pudo comentar el diagrama:', (error as Error).message);
    }
  }
}
