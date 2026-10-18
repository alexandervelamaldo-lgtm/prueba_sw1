import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantContext, AssistantEngine } from './assistant.js';
import type { ClassDiagram } from '@app/shared';
import type { ConversationStore, ChatMessage } from '../storage/conversaciones.js';
import type { DocumentStore } from '../storage/documents.js';
import { Room } from '../collab/rooms.js';
import { VigilanteDiagrama } from './vigilancia.js';

/**
 * Pruebas del vigilante que hace que el Modo IA hable sin que nadie le
 * pregunte. No contra una sala ni un asistente de verdad: lo que hay que
 * sujetar es el *cuándo* (debounce, enfriamiento, sala vacía), no el *qué*
 * dice la IA, que ya prueba `assistant.test.ts`.
 */

/** Documentos en memoria: a esta prueba no le importa qué se persiste. */
class AlmacenDeDocumentosFalso implements DocumentStore {
  async load(): Promise<Uint8Array | null> {
    return null;
  }
  async save(): Promise<void> {}
  async delete(): Promise<void> {}
}

function crearSala(id = 'proyecto-1'): Room {
  return new Room(id, new AlmacenDeDocumentosFalso(), 60_000);
}

/** Conexión mínima, solo para que `room.connections.size` no sea cero. */
function crearConexion(userId = 'alguien') {
  return { userId, canWrite: true, send: () => {}, close: () => {} };
}

/**
 * Un cambio en el diagrama hecho por `autor`. El origen de la transacción es
 * la conexión de quien editó, igual que en `CollabServer`, que es de donde el
 * vigilante saca a quién dirigir el comentario.
 */
function cambiar(sala: Room, autor: unknown = crearConexion()): void {
  sala.doc.transact(() => {
    sala.doc.getMap('cambios').set('n', Math.random());
  }, autor);
}

class AsistenteFalso implements AssistantEngine {
  readonly name = 'falso';
  llamadas = 0;
  siguienteComentario: string | null = 'Esta clase parece aislada.';

  async interpret(): Promise<never> {
    throw new Error('no usado en estas pruebas');
  }

  async revisar(_diagram: ClassDiagram, _contexto?: AssistantContext): Promise<string | null> {
    this.llamadas += 1;
    return this.siguienteComentario;
  }
}

class ConversacionesFalsas implements ConversationStore {
  comentarios: { proyectoId: string; usuarioId: string; texto: string }[] = [];

  async getHistory(): Promise<ChatMessage[]> {
    return [];
  }
  async appendTurn(): Promise<void> {}
  async appendComentario(proyectoId: string, usuarioId: string, texto: string): Promise<void> {
    this.comentarios.push({ proyectoId, usuarioId, texto });
  }
  async borrarProyecto(): Promise<void> {}
}

let asistente: AsistenteFalso;
let conversaciones: ConversacionesFalsas;

/** Espera corta y enfriamiento corto: lo que cambia entre pruebas es el reloj, no la lógica. */
const ESPERA_MS = 50;
const ENFRIAMIENTO_MS = 200;

beforeEach(() => {
  asistente = new AsistenteFalso();
  conversaciones = new ConversacionesFalsas();
});

afterEach(() => {
  vi.useRealTimers();
});

function crearVigilante(): VigilanteDiagrama {
  return new VigilanteDiagrama(asistente, conversaciones, ESPERA_MS, ENFRIAMIENTO_MS);
}

describe('debounce tras el último cambio', () => {
  it('no comenta antes de que pase la espera', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion());
    vigilante.observar('proyecto-1', sala);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS / 2));

    expect(conversaciones.comentarios).toHaveLength(0);
  });

  it('una ráfaga de cambios produce un solo comentario, no uno por cambio', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion());
    vigilante.observar('proyecto-1', sala);

    for (let i = 0; i < 5; i += 1) {
      cambiar(sala);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // La última de la ráfaga reinicia la espera: hay que dejarla pasar entera
    // desde ese último cambio, no desde el primero.
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(1);
    expect(asistente.llamadas).toBe(1);
  });
});

describe('sala sin nadie conectado', () => {
  it('no comenta: el comentario se perdería sin nadie a quien hablarle', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    // A propósito, sin añadir ninguna conexión.
    vigilante.observar('proyecto-1', sala);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(0);
    expect(asistente.llamadas).toBe(0);
  });
});

describe('cuando el asistente no tiene nada que decir', () => {
  it('no se guarda ningún comentario', async () => {
    asistente.siguienteComentario = null;
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion());
    vigilante.observar('proyecto-1', sala);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(asistente.llamadas).toBe(1);
    expect(conversaciones.comentarios).toHaveLength(0);
  });
});

describe('enfriamiento entre comentarios espontáneos', () => {
  it('un segundo cambio dentro del enfriamiento no produce un segundo comentario', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion());
    vigilante.observar('proyecto-1', sala);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));
    expect(conversaciones.comentarios).toHaveLength(1);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    // El asistente se consultó la segunda vez (la espera ya pasó), pero el
    // enfriamiento impide que ese segundo hallazgo se llegue a guardar.
    expect(conversaciones.comentarios).toHaveLength(1);
  });

  it('pasado el enfriamiento, un nuevo cambio sí puede comentar otra vez', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion());
    vigilante.observar('proyecto-1', sala);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));
    expect(conversaciones.comentarios).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, ENFRIAMIENTO_MS));

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(2);
  });
});

describe('observar la misma sala dos veces', () => {
  it('no duplica el oyente: una sola sala sigue dando un solo comentario por ráfaga', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion());
    // Simula lo que hace `CollabServer`: llamar a `observar` en cada conexión
    // nueva a la misma sala.
    vigilante.observar('proyecto-1', sala);
    vigilante.observar('proyecto-1', sala);
    vigilante.observar('proyecto-1', sala);

    cambiar(sala);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(1);
  });
});

describe('dos salas distintas del mismo proyecto', () => {
  it('una sala nueva que sustituye a una vacía se vigila por sí misma', async () => {
    // Esto es lo que `WeakSet<Room>` existe para permitir: si se guardara el
    // id del proyecto en vez de la instancia, esta segunda sala —que
    // sustituye a una destruida tras `closeIfEmpty`— se quedaría sin oyente.
    const vigilante = crearVigilante();

    const salaVieja = crearSala('proyecto-1');
    salaVieja.connections.add(crearConexion());
    vigilante.observar('proyecto-1', salaVieja);

    const salaNueva = crearSala('proyecto-1');
    salaNueva.connections.add(crearConexion());
    vigilante.observar('proyecto-1', salaNueva);

    cambiar(salaNueva);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(1);
    expect(conversaciones.comentarios[0]?.proyectoId).toBe('proyecto-1');
  });
});

describe('a quién va el comentario', () => {
  it('va al hilo de quien hizo el último cambio', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion('ana'));
    sala.connections.add(crearConexion('beto'));
    vigilante.observar('proyecto-1', sala);

    cambiar(sala, crearConexion('ana'));
    cambiar(sala, crearConexion('beto'));
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toEqual([
      { proyectoId: 'proyecto-1', usuarioId: 'beto', texto: 'Esta clase parece aislada.' },
    ]);
  });

  it('también cuando el cambio entró por la API con el usuario como origen', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion('ana'));
    vigilante.observar('proyecto-1', sala);

    cambiar(sala, { userId: 'carla' });
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios.map((c) => c.usuarioId)).toEqual(['carla']);
  });

  it('si el último cambio de la ráfaga no tiene autor, no se le atribuye al anterior', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion('ana'));
    vigilante.observar('proyecto-1', sala);

    cambiar(sala, crearConexion('ana'));
    cambiar(sala, 'restauracion');
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(0);
  });

  it('el autor de una ráfaga ya comentada no se arrastra a la siguiente', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion('ana'));
    vigilante.observar('proyecto-1', sala);

    cambiar(sala, crearConexion('ana'));
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));
    // Pasado el enfriamiento, un cambio sin autor no debe ir al hilo de Ana.
    await new Promise((resolve) => setTimeout(resolve, ENFRIAMIENTO_MS));
    cambiar(sala, 'restauracion');
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios.map((c) => c.usuarioId)).toEqual(['ana']);
  });

  it('un cambio sin autor conocido no produce comentario: no hay hilo al que dirigirlo', async () => {
    const vigilante = crearVigilante();
    const sala = crearSala();
    sala.connections.add(crearConexion('ana'));
    vigilante.observar('proyecto-1', sala);

    cambiar(sala, 'persistencia');
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS + 20));

    expect(conversaciones.comentarios).toHaveLength(0);
    expect(asistente.llamadas).toBe(0);
  });
});
