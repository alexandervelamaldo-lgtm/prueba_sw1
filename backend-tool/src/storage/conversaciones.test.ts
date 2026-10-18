import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConversationStore, MAXIMO_TURNOS } from './conversaciones.js';

/**
 * Pruebas del almacén de conversaciones del Modo IA, contra el disco de
 * verdad.
 *
 * Lo que importa comprobar no es tanto "se guarda" sino que cada integrante
 * tiene su propio hilo dentro de un proyecto, y que nadie ve el de otro: es
 * justo lo que una prueba con un doble en memoria no pondría en duda —un mapa
 * en memoria no distingue una clave mal construida de una buena—.
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
    expect(await almacen.getHistory(P, ANA, MAXIMO_TURNOS * 2)).toEqual([]);
  });

  it('cada turno queda como dos mensajes, el autor y luego el asistente', async () => {
    await almacen.appendTurn(P, ANA, 'crea la clase Pedido', 'Hecho: clase Pedido creada.');
    const historial = await almacen.getHistory(P, ANA, 10);
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
    const historial = await almacen.getHistory(P, ANA, 10);
    expect(historial.map((m) => m.texto)).toEqual(['uno', 'respuesta uno', 'dos', 'respuesta dos']);
  });

  it('un límite menor que lo guardado devuelve los más recientes, no los más antiguos', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    const historial = await almacen.getHistory(P, ANA, 2);
    expect(historial.map((m) => m.texto)).toEqual(['orden 5', 'respuesta 5']);
  });

  it('un límite de cero no descarga la conversación entera', async () => {
    // Mismo motivo que en `tablon.ts`: `slice(-0)` devuelve todo el arreglo.
    await almacen.appendTurn(P, ANA, 'uno', 'respuesta uno');
    const historial = await almacen.getHistory(P, ANA, 0);
    expect(historial).toHaveLength(1);
  });
});

describe('un hilo por integrante', () => {
  it('dos integrantes del mismo proyecto no ven el hilo del otro', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');

    expect((await almacen.getHistory(P, ANA, 10)).map((m) => m.texto)).toEqual([
      'orden de Ana',
      'respuesta a Ana',
    ]);
    expect((await almacen.getHistory(P, BETO, 10)).map((m) => m.texto)).toEqual([
      'orden de Beto',
      'respuesta a Beto',
    ]);
  });

  it('el mismo usuario en dos proyectos distintos no comparte historial', async () => {
    await almacen.appendTurn(P, ANA, 'orden en Tienda', 'respuesta en Tienda');
    await almacen.appendTurn(OTRO_PROYECTO, ANA, 'orden en Clínica', 'respuesta en Clínica');

    const enTienda = await almacen.getHistory(P, ANA, 10);
    const enClinica = await almacen.getHistory(OTRO_PROYECTO, ANA, 10);

    expect(enTienda.map((m) => m.texto)).toEqual(['orden en Tienda', 'respuesta en Tienda']);
    expect(enClinica.map((m) => m.texto)).toEqual(['orden en Clínica', 'respuesta en Clínica']);
  });

  it('un comentario espontáneo solo aparece en el hilo de su destinatario', async () => {
    await almacen.appendComentario(P, BETO, 'Cliente no tiene id.');

    expect(await almacen.getHistory(P, ANA, 10)).toEqual([]);
    expect((await almacen.getHistory(P, BETO, 10)).map((m) => m.texto)).toEqual(['Cliente no tiene id.']);
  });

  it('los mensajes del hilo compartido anterior no aparecen en ningún hilo', async () => {
    await almacen.flush();
    const ruta = join(dataDir, 'conversaciones', `${P}.json`);
    await mkdir(join(dataDir, 'conversaciones'), { recursive: true });
    await writeFile(
      ruta,
      JSON.stringify({
        mensajes: [
          { role: 'user', texto: 'orden vieja', autorId: ANA, creadoEn: '2026-01-01T00:00:00.000Z', tipo: 'respuesta' },
          { role: 'assistant', texto: 'respuesta vieja', autorId: null, creadoEn: '2026-01-01T00:00:00.001Z', tipo: 'respuesta' },
        ],
      }),
      'utf8',
    );

    const reabierto = new FileConversationStore(dataDir);
    expect(await reabierto.getHistory(P, ANA, 10)).toEqual([]);
  });
});

describe('ventana de turnos', () => {
  it('no guarda más de MAXIMO_TURNOS turnos por integrante: los más antiguos se descartan', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS + 5; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    const historial = await almacen.getHistory(P, ANA, MAXIMO_TURNOS * 2 + 100);
    expect(historial).toHaveLength(MAXIMO_TURNOS * 2);
    expect(historial[0]).toMatchObject({ texto: 'orden 6' });
    expect(historial.at(-1)).toMatchObject({ texto: `respuesta ${MAXIMO_TURNOS + 5}` });
  });

  it('el hilo de un integrante no le quita sitio al de otro', async () => {
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');
    for (let i = 1; i <= MAXIMO_TURNOS + 5; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    expect((await almacen.getHistory(P, BETO, 10)).map((m) => m.texto)).toEqual([
      'orden de Beto',
      'respuesta a Beto',
    ]);
  });
});

describe('persistencia', () => {
  it('lo guardado sobrevive a reabrir el almacén', async () => {
    await almacen.appendTurn(P, ANA, 'persistente', 'sigue aquí');
    await almacen.flush();

    const reabierto = new FileConversationStore(dataDir);
    const historial = await reabierto.getHistory(P, ANA, 10);
    expect(historial.map((m) => m.texto)).toEqual(['persistente', 'sigue aquí']);
  });
});

describe('borrarProyecto', () => {
  it('se lleva el historial de todos los integrantes de ese proyecto', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');

    await almacen.borrarProyecto(P);

    expect(await almacen.getHistory(P, ANA, 10)).toEqual([]);
    expect(await almacen.getHistory(P, BETO, 10)).toEqual([]);
  });

  it('no toca el historial de otro proyecto', async () => {
    await almacen.appendTurn(P, ANA, 'orden en Tienda', 'respuesta en Tienda');
    await almacen.appendTurn(OTRO_PROYECTO, ANA, 'orden en Clínica', 'respuesta en Clínica');

    await almacen.borrarProyecto(P);

    expect(await almacen.getHistory(OTRO_PROYECTO, ANA, 10)).toHaveLength(2);
  });
});

describe('appendComentario', () => {
  it('añade un único mensaje de rol assistant, sin autor y marcado como observación', async () => {
    await almacen.appendComentario(P, ANA, 'Esta relación parece de agregación, no de composición.');
    const historial = await almacen.getHistory(P, ANA, 10);
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
    const historial = await almacen.getHistory(P, ANA, 10);
    expect(historial.map((m) => m.tipo)).toEqual(['respuesta', 'respuesta']);
  });

  it('cuenta hacia la misma ventana de MAXIMO_TURNOS que los turnos normales', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    await almacen.appendComentario(P, ANA, 'comentario espontáneo');

    const historial = await almacen.getHistory(P, ANA, MAXIMO_TURNOS * 2 + 10);
    expect(historial).toHaveLength(MAXIMO_TURNOS * 2);
    // El comentario es un solo mensaje, no un turno de dos: al sobrepasar la
    // ventana se descarta solo el mensaje más antiguo (la orden del primer
    // turno), no el turno entero.
    expect(historial.at(-1)).toMatchObject({ texto: 'comentario espontáneo', tipo: 'observacion' });
    expect(historial[0]).toMatchObject({ texto: 'respuesta 1' });
  });

  it('lo guardado por appendComentario sobrevive a reabrir el almacén', async () => {
    await almacen.appendComentario(P, ANA, 'persistente también');
    await almacen.flush();

    const reabierto = new FileConversationStore(dataDir);
    const historial = await reabierto.getHistory(P, ANA, 10);
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
    const historial = await reabierto.getHistory(P, ANA, 10);
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
    await expect(almacen.appendTurn(P, '../no-es-una-ruta', 'hola', 'hola')).resolves.toEqual([]);
    const historial = await almacen.getHistory(P, '../no-es-una-ruta', 10);
    expect(historial[0]).toMatchObject({ autorId: '../no-es-una-ruta' });
  });
});

describe('resumen de lo que salió de la ventana', () => {
  it('no hay resumen hasta que se guarda uno', async () => {
    expect(await almacen.getResumen(P, ANA)).toBeNull();
  });

  it('cada integrante tiene el suyo', async () => {
    await almacen.setResumen(P, ANA, 'Ana modeló una tienda.');

    expect(await almacen.getResumen(P, ANA)).toBe('Ana modeló una tienda.');
    expect(await almacen.getResumen(P, BETO)).toBeNull();
  });

  it('sobrevive a reabrir el almacén y se va con el proyecto', async () => {
    await almacen.setResumen(P, ANA, 'persistente');
    await almacen.flush();
    expect(await new FileConversationStore(dataDir).getResumen(P, ANA)).toBe('persistente');

    await almacen.borrarProyecto(P);
    expect(await almacen.getResumen(P, ANA)).toBeNull();
  });
});

describe('appendTurn devuelve lo que podó', () => {
  it('con sitio en la ventana no poda nada', async () => {
    expect(await almacen.appendTurn(P, ANA, 'uno', 'respuesta uno')).toEqual([]);
  });

  it('devuelve los mensajes del hilo que salieron de la ventana, del más antiguo al más reciente', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    await almacen.appendTurn(P, BETO, 'de Beto', 'para Beto');

    const podados = await almacen.appendTurn(P, ANA, 'orden nueva', 'respuesta nueva');

    expect(podados.map((m) => m.texto)).toEqual(['orden 1', 'respuesta 1']);
    expect(podados[0]).toMatchObject({ role: 'user', autorId: ANA, tipo: 'respuesta' });
  });
});

describe('pedidos a la vez al abrir el almacén', () => {
  it('dos turnos antes de la primera lectura del fichero no se pisan', async () => {
    await almacen.appendTurn(P, ANA, 'orden previa', 'respuesta previa');
    await almacen.flush();
    const reabierto = new FileConversationStore(dataDir);

    await Promise.all([
      reabierto.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana'),
      reabierto.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto'),
    ]);
    await reabierto.flush();

    const releido = new FileConversationStore(dataDir);
    expect((await releido.getHistory(P, ANA, 10)).map((m) => m.texto)).toEqual([
      'orden previa',
      'respuesta previa',
      'orden de Ana',
      'respuesta a Ana',
    ]);
    expect((await releido.getHistory(P, BETO, 10)).map((m) => m.texto)).toEqual(['orden de Beto', 'respuesta a Beto']);
  });
});
