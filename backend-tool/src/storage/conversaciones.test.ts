import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConversationStore, MAXIMO_TURNOS } from './conversaciones.js';

/**
 * Pruebas del almacén de conversaciones del Modo IA, contra el disco de
 * verdad.
 *
 * Lo que importa comprobar no es tanto "se guarda" sino que el hilo es
 * compartido dentro de un proyecto: es la condición que puso el encargo
 * ("contexto de todos los integrantes") y es justo lo que una prueba con un
 * doble en memoria no pondría en duda —un mapa compartido en memoria no
 * distingue una clave mal construida de una buena—.
 */

let dataDir: string;
let almacen: FileConversationStore;

const P = 'proyecto-1';
const OTRO_PROYECTO = 'proyecto-2';
const ANA = 'usuario-ana';
const BETO = 'usuario-beto';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'uml-conversaciones-'));
  almacen = new FileConversationStore(dataDir);
});

afterEach(async () => {
  await almacen.flush();
  await rm(dataDir, { recursive: true, force: true });
});

describe('getHistory', () => {
  it('un proyecto sin conversación devuelve una lista vacía', async () => {
    expect(await almacen.getHistory(P, MAXIMO_TURNOS * 2)).toEqual([]);
  });

  it('cada turno queda como dos mensajes, el autor y luego el asistente', async () => {
    await almacen.appendTurn(P, ANA, 'crea la clase Pedido', 'Hecho: clase Pedido creada.');
    const historial = await almacen.getHistory(P, 10);
    expect(historial).toHaveLength(2);
    expect(historial[0]).toMatchObject({ role: 'user', texto: 'crea la clase Pedido', autorId: ANA });
    expect(historial[1]).toMatchObject({
      role: 'assistant',
      texto: 'Hecho: clase Pedido creada.',
      autorId: null,
    });
  });

  it('devuelve los mensajes en orden cronológico', async () => {
    await almacen.appendTurn(P, ANA, 'uno', 'respuesta uno');
    await almacen.appendTurn(P, ANA, 'dos', 'respuesta dos');
    const historial = await almacen.getHistory(P, 10);
    expect(historial.map((m) => m.texto)).toEqual(['uno', 'respuesta uno', 'dos', 'respuesta dos']);
  });

  it('un límite menor que lo guardado devuelve los más recientes, no los más antiguos', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    const historial = await almacen.getHistory(P, 2);
    expect(historial.map((m) => m.texto)).toEqual(['orden 5', 'respuesta 5']);
  });

  it('un límite de cero no descarga la conversación entera', async () => {
    // Mismo motivo que en `tablon.ts`: `slice(-0)` devuelve todo el arreglo.
    await almacen.appendTurn(P, ANA, 'uno', 'respuesta uno');
    const historial = await almacen.getHistory(P, 0);
    expect(historial).toHaveLength(1);
  });
});

describe('hilo compartido del proyecto', () => {
  it('dos integrantes del mismo proyecto comparten el mismo historial', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');

    // No hay "el historial de Ana" y "el de Beto": los dos ven las cuatro
    // filas, en el orden en que se escribieron.
    const historial = await almacen.getHistory(P, 10);
    expect(historial.map((m) => m.texto)).toEqual([
      'orden de Ana',
      'respuesta a Ana',
      'orden de Beto',
      'respuesta a Beto',
    ]);
  });

  it('cada mensaje de usuario conserva quién lo escribió', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');

    const historial = await almacen.getHistory(P, 10);
    const autores = historial.filter((m) => m.role === 'user').map((m) => m.autorId);
    expect(autores).toEqual([ANA, BETO]);
  });

  it('el mismo usuario en dos proyectos distintos no comparte historial', async () => {
    await almacen.appendTurn(P, ANA, 'orden en Tienda', 'respuesta en Tienda');
    await almacen.appendTurn(OTRO_PROYECTO, ANA, 'orden en Clínica', 'respuesta en Clínica');

    const enTienda = await almacen.getHistory(P, 10);
    const enClinica = await almacen.getHistory(OTRO_PROYECTO, 10);

    expect(enTienda.map((m) => m.texto)).toEqual(['orden en Tienda', 'respuesta en Tienda']);
    expect(enClinica.map((m) => m.texto)).toEqual(['orden en Clínica', 'respuesta en Clínica']);
  });
});

describe('ventana de turnos', () => {
  it('no guarda más de MAXIMO_TURNOS turnos entre todos los integrantes: los más antiguos se descartan', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS + 5; i += 1) {
      await almacen.appendTurn(P, i % 2 === 0 ? ANA : BETO, `orden ${i}`, `respuesta ${i}`);
    }
    const historial = await almacen.getHistory(P, MAXIMO_TURNOS * 2 + 100);
    expect(historial).toHaveLength(MAXIMO_TURNOS * 2);
    // El primero que sobrevive es el turno número 6: los cinco primeros se
    // podaron para dejar sitio a los últimos veinte, sin importar quién los
    // escribió.
    expect(historial[0]).toMatchObject({ texto: 'orden 6' });
    expect(historial.at(-1)).toMatchObject({ texto: `respuesta ${MAXIMO_TURNOS + 5}` });
  });
});

describe('persistencia', () => {
  it('lo guardado sobrevive a reabrir el almacén', async () => {
    await almacen.appendTurn(P, ANA, 'persistente', 'sigue aquí');
    await almacen.flush();

    const reabierto = new FileConversationStore(dataDir);
    const historial = await reabierto.getHistory(P, 10);
    expect(historial.map((m) => m.texto)).toEqual(['persistente', 'sigue aquí']);
  });
});

describe('borrarProyecto', () => {
  it('se lleva el historial de todos los integrantes de ese proyecto', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');

    await almacen.borrarProyecto(P);

    expect(await almacen.getHistory(P, 10)).toEqual([]);
  });

  it('no toca el historial de otro proyecto', async () => {
    await almacen.appendTurn(P, ANA, 'orden en Tienda', 'respuesta en Tienda');
    await almacen.appendTurn(OTRO_PROYECTO, ANA, 'orden en Clínica', 'respuesta en Clínica');

    await almacen.borrarProyecto(P);

    expect(await almacen.getHistory(OTRO_PROYECTO, 10)).toHaveLength(2);
  });
});

describe('appendComentario', () => {
  it('añade un único mensaje de rol assistant, sin autor y marcado como observación', async () => {
    await almacen.appendComentario(P, 'Esta relación parece de agregación, no de composición.');
    const historial = await almacen.getHistory(P, 10);
    expect(historial).toHaveLength(1);
    expect(historial[0]).toMatchObject({
      role: 'assistant',
      texto: 'Esta relación parece de agregación, no de composición.',
      autorId: null,
      tipo: 'observacion',
    });
  });

  it('un turno normal se marca como respuesta, no como observación', async () => {
    await almacen.appendTurn(P, ANA, 'crea la clase Pedido', 'Hecho.');
    const historial = await almacen.getHistory(P, 10);
    expect(historial.map((m) => m.tipo)).toEqual(['respuesta', 'respuesta']);
  });

  it('cuenta hacia la misma ventana de MAXIMO_TURNOS que los turnos normales', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    await almacen.appendComentario(P, 'comentario espontáneo');

    const historial = await almacen.getHistory(P, MAXIMO_TURNOS * 2 + 10);
    expect(historial).toHaveLength(MAXIMO_TURNOS * 2);
    // El comentario es un solo mensaje, no un turno de dos: al sobrepasar la
    // ventana se descarta solo el mensaje más antiguo (la orden del primer
    // turno), no el turno entero.
    expect(historial.at(-1)).toMatchObject({ texto: 'comentario espontáneo', tipo: 'observacion' });
    expect(historial[0]).toMatchObject({ texto: 'respuesta 1' });
  });

  it('lo guardado por appendComentario sobrevive a reabrir el almacén', async () => {
    await almacen.appendComentario(P, 'persistente también');
    await almacen.flush();

    const reabierto = new FileConversationStore(dataDir);
    const historial = await reabierto.getHistory(P, 10);
    expect(historial[0]).toMatchObject({ texto: 'persistente también', tipo: 'observacion' });
  });
});

describe('tipo por defecto en mensajes antiguos', () => {
  it('un mensaje guardado antes de que existiera "tipo" se lee como respuesta', async () => {
    await almacen.appendTurn(P, ANA, 'orden vieja', 'respuesta vieja');
    await almacen.flush();

    // Simula un fichero de una versión anterior a `tipo`: se relee el mismo
    // fichero pero sin ese campo, como si nunca se hubiera escrito.
    const ruta = join(dataDir, 'conversaciones', `${P}.json`);
    const crudo = JSON.parse(await readFile(ruta, 'utf8'));
    for (const mensaje of crudo.mensajes) delete mensaje.tipo;
    await writeFile(ruta, JSON.stringify(crudo), 'utf8');

    const reabierto = new FileConversationStore(dataDir);
    const historial = await reabierto.getHistory(P, 10);
    expect(historial.map((m) => m.tipo)).toEqual(['respuesta', 'respuesta']);
  });
});

describe('identificadores', () => {
  it('un proyecto con travesía falla en vez de escribir fuera', async () => {
    await expect(almacen.appendTurn('../fuera', ANA, 'hola', 'hola')).rejects.toThrow(/no admisible/);
  });

  it('el autor ya no forma parte de ninguna ruta de fichero: no hace falta que sea un id seguro', async () => {
    // Antes esto habría fallado: `autorId` era un segmento de ruta
    // (`<proyecto>/<usuario>.json`). Ahora es solo un dato dentro del fichero
    // del proyecto, así que un valor con barras se guarda tal cual.
    await expect(almacen.appendTurn(P, '../no-es-una-ruta', 'hola', 'hola')).resolves.toBeUndefined();
    const historial = await almacen.getHistory(P, 10);
    expect(historial[0]).toMatchObject({ autorId: '../no-es-una-ruta' });
  });
});
