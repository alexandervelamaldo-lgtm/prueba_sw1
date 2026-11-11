import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConversationStore, MAXIMO_TURNOS } from './conversaciones.js';

/**
 * Pruebas del almacén de conversaciones del Modo IA, contra el disco de
 * verdad.
 *
 * El hilo es del proyecto, no de cada integrante (ver la cabecera de
 * `conversaciones.ts`): lo que importa comprobar es que todos los mensajes de
 * un proyecto —de quien sea su autor— caen en un único hilo compartido, que
 * ese hilo no se mezcla con el de otro proyecto, y que `autorId` sigue
 * distinguiendo quién escribió cada mensaje dentro de ese hilo único.
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

describe('un hilo por proyecto, compartido por sus integrantes', () => {
  it('dos integrantes del mismo proyecto comparten un único hilo, en el orden en que escribieron', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');

    const historial = await almacen.getHistory(P, 10);
    expect(historial.map((m) => m.texto)).toEqual([
      'orden de Ana',
      'respuesta a Ana',
      'orden de Beto',
      'respuesta a Beto',
    ]);
    expect(historial.map((m) => m.autorId)).toEqual([ANA, null, BETO, null]);
  });

  it('el mismo usuario en dos proyectos distintos no comparte historial', async () => {
    await almacen.appendTurn(P, ANA, 'orden en Tienda', 'respuesta en Tienda');
    await almacen.appendTurn(OTRO_PROYECTO, ANA, 'orden en Clínica', 'respuesta en Clínica');

    const enTienda = await almacen.getHistory(P, 10);
    const enClinica = await almacen.getHistory(OTRO_PROYECTO, 10);

    expect(enTienda.map((m) => m.texto)).toEqual(['orden en Tienda', 'respuesta en Tienda']);
    expect(enClinica.map((m) => m.texto)).toEqual(['orden en Clínica', 'respuesta en Clínica']);
  });

  it('un comentario espontáneo aparece en el hilo único del proyecto, lo vea quien lo vea', async () => {
    await almacen.appendTurn(P, ANA, 'orden de Ana', 'respuesta a Ana');
    await almacen.appendComentario(P, 'Cliente no tiene id.');

    expect((await almacen.getHistory(P, 10)).map((m) => m.texto)).toEqual([
      'orden de Ana',
      'respuesta a Ana',
      'Cliente no tiene id.',
    ]);
  });

  it('un hilo de la época de un hilo por integrante se lee fusionado, en el orden en que quedó en disco', async () => {
    await almacen.flush();
    const ruta = join(dataDir, 'conversaciones', `${P}.json`);
    await mkdir(join(dataDir, 'conversaciones'), { recursive: true });
    await writeFile(
      ruta,
      JSON.stringify({
        mensajes: [
          {
            role: 'user',
            texto: 'orden vieja de Ana',
            autorId: ANA,
            creadoEn: '2026-01-01T00:00:00.000Z',
            tipo: 'respuesta',
            hiloDe: ANA,
          },
          {
            role: 'assistant',
            texto: 'respuesta vieja a Ana',
            autorId: null,
            creadoEn: '2026-01-01T00:00:00.001Z',
            tipo: 'respuesta',
            hiloDe: ANA,
          },
          {
            role: 'user',
            texto: 'orden vieja de Beto',
            autorId: BETO,
            creadoEn: '2026-01-01T00:00:01.000Z',
            tipo: 'respuesta',
            hiloDe: BETO,
          },
        ],
      }),
      'utf8',
    );

    const reabierto = new FileConversationStore(dataDir);
    const historial = await reabierto.getHistory(P, 10);
    expect(historial.map((m) => m.texto)).toEqual([
      'orden vieja de Ana',
      'respuesta vieja a Ana',
      'orden vieja de Beto',
    ]);
  });
});

describe('ventana de turnos', () => {
  it('no guarda más de MAXIMO_TURNOS turnos por proyecto: los más antiguos se descartan', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS + 5; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    const historial = await almacen.getHistory(P, MAXIMO_TURNOS * 2 + 100);
    expect(historial).toHaveLength(MAXIMO_TURNOS * 2);
    expect(historial[0]).toMatchObject({ texto: 'orden 6' });
    expect(historial.at(-1)).toMatchObject({ texto: `respuesta ${MAXIMO_TURNOS + 5}` });
  });

  it('la ventana es del proyecto entero: los turnos de un integrante le quitan sitio al de otro', async () => {
    await almacen.appendTurn(P, BETO, 'orden de Beto', 'respuesta a Beto');
    for (let i = 1; i <= MAXIMO_TURNOS; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }
    // El turno de Beto fue el primero en entrar: con la ventana llena por los
    // de Ana, es el primero en salir.
    const historial = await almacen.getHistory(P, MAXIMO_TURNOS * 2 + 10);
    expect(historial.map((m) => m.texto)).not.toContain('orden de Beto');
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
  it('se lleva el hilo entero del proyecto', async () => {
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

  it('el autor no forma parte de ninguna ruta de fichero: no hace falta que sea un id seguro', async () => {
    // `autorId` es solo un dato dentro del fichero del proyecto, no un
    // segmento de ruta, así que un valor con barras se guarda tal cual.
    await expect(almacen.appendTurn(P, '../no-es-una-ruta', 'hola', 'hola')).resolves.toEqual([]);
    const historial = await almacen.getHistory(P, 10);
    expect(historial[0]).toMatchObject({ autorId: '../no-es-una-ruta' });
  });
});

describe('resumen de lo que salió de la ventana', () => {
  it('no hay resumen hasta que se guarda uno', async () => {
    expect(await almacen.getResumen(P)).toBeNull();
  });

  it('es del proyecto, no de quien lo generó', async () => {
    await almacen.setResumen(P, 'Ana y Beto modelaron una tienda.');

    expect(await almacen.getResumen(P)).toBe('Ana y Beto modelaron una tienda.');
    expect(await almacen.getResumen(OTRO_PROYECTO)).toBeNull();
  });

  it('sobrevive a reabrir el almacén y se va con el proyecto', async () => {
    await almacen.setResumen(P, 'persistente');
    await almacen.flush();
    expect(await new FileConversationStore(dataDir).getResumen(P)).toBe('persistente');

    await almacen.borrarProyecto(P);
    expect(await almacen.getResumen(P)).toBeNull();
  });
});

describe('appendTurn devuelve lo que podó', () => {
  it('con sitio en la ventana no poda nada', async () => {
    expect(await almacen.appendTurn(P, ANA, 'uno', 'respuesta uno')).toEqual([]);
  });

  it('devuelve los mensajes del hilo que salieron de la ventana, del más antiguo al más reciente', async () => {
    await almacen.appendTurn(P, BETO, 'de Beto', 'para Beto');
    // `recortar` se ejecuta tras cada `appendTurn`, no solo al final: con
    // MAXIMO_TURNOS turnos de Ana la ventana ya habría quedado llena y el
    // turno de Beto se habría podado dentro mismo de este bucle. Un turno
    // menos deja la ventana exactamente llena (Beto + MAXIMO_TURNOS - 1 de
    // Ana = MAXIMO_TURNOS * 2 mensajes) sin que nadie haya salido todavía.
    for (let i = 1; i < MAXIMO_TURNOS; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }

    const podados = await almacen.appendTurn(P, ANA, 'orden nueva', 'respuesta nueva');

    // El turno de Beto entró primero, así que es el primero en salir.
    expect(podados.map((m) => m.texto)).toEqual(['de Beto', 'para Beto']);
    expect(podados[0]).toMatchObject({ role: 'user', autorId: BETO, tipo: 'respuesta' });
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
    const historial = (await releido.getHistory(P, 10)).map((m) => m.texto);
    expect(historial).toContain('orden previa');
    expect(historial).toContain('orden de Ana');
    expect(historial).toContain('orden de Beto');
    expect(historial).toHaveLength(6);
  });
});

describe('appendComentario devuelve lo que podó', () => {
  it('un comentario que empuja un mensaje fuera de la ventana lo devuelve', async () => {
    for (let i = 1; i <= MAXIMO_TURNOS; i += 1) {
      await almacen.appendTurn(P, ANA, `orden ${i}`, `respuesta ${i}`);
    }

    const podados = await almacen.appendComentario(P, 'comentario');

    expect(podados.map((m) => m.texto)).toEqual(['orden 1']);
  });

  it('con sitio en la ventana no poda nada', async () => {
    expect(await almacen.appendComentario(P, 'comentario')).toEqual([]);
  });
});
