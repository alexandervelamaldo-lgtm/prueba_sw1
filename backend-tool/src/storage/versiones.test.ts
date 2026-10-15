import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileVersionStore } from './versiones.js';

/**
 * Pruebas del almacén de versiones, contra el disco de verdad.
 *
 * Igual que en `conversaciones.test.ts`: lo que importa no es solo "se
 * guarda" sino que el estado (el blob grande) y el índice (lo ligero que se
 * lista) sobrevivan juntos y coherentes, y que un proyecto no vea las
 * versiones de otro.
 */

let dataDir: string;
let almacen: FileVersionStore;

const P = 'proyecto-1';
const OTRO_PROYECTO = 'proyecto-2';
const U = 'usuario-1';

function estadoDePrueba(texto: string): Uint8Array {
  return new TextEncoder().encode(texto);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'uml-versiones-'));
  almacen = new FileVersionStore(dataDir);
});

afterEach(async () => {
  await almacen.flush();
  await rm(dataDir, { recursive: true, force: true });
});

describe('crear y listar', () => {
  it('un proyecto sin versiones devuelve una lista vacía', async () => {
    expect(await almacen.listar(P)).toEqual([]);
  });

  it('crear devuelve el resumen, sin el estado', async () => {
    const resumen = await almacen.crear({
      proyectoId: P,
      estado: estadoDePrueba('v1'),
      mensaje: 'Antes de refactorizar Pedido',
      autorId: U,
    });
    expect(resumen).toMatchObject({ proyectoId: P, mensaje: 'Antes de refactorizar Pedido', autorId: U });
    expect(resumen).not.toHaveProperty('estado');
    expect(typeof resumen.id).toBe('string');
    expect(typeof resumen.creadoEn).toBe('string');
  });

  it('listar devuelve los resúmenes en orden cronológico ascendente', async () => {
    await almacen.crear({ proyectoId: P, estado: estadoDePrueba('v1'), mensaje: 'uno', autorId: U });
    await almacen.crear({ proyectoId: P, estado: estadoDePrueba('v2'), mensaje: 'dos', autorId: U });
    await almacen.crear({ proyectoId: P, estado: estadoDePrueba('v3'), mensaje: 'tres', autorId: U });

    const listado = await almacen.listar(P);
    expect(listado.map((v) => v.mensaje)).toEqual(['uno', 'dos', 'tres']);
  });
});

describe('obtener', () => {
  it('devuelve la versión con su estado', async () => {
    const creada = await almacen.crear({
      proyectoId: P,
      estado: estadoDePrueba('contenido-binario'),
      mensaje: 'checkpoint',
      autorId: U,
    });

    const version = await almacen.obtener(P, creada.id);
    expect(version).not.toBeNull();
    expect(new TextDecoder().decode(version!.estado)).toBe('contenido-binario');
    expect(version).toMatchObject({ id: creada.id, proyectoId: P, mensaje: 'checkpoint' });
  });

  it('una versión inexistente devuelve null', async () => {
    expect(await almacen.obtener(P, 'no-existe')).toBeNull();
  });

  it('una versión que existe pero es de otro proyecto devuelve null', async () => {
    const creada = await almacen.crear({
      proyectoId: P,
      estado: estadoDePrueba('v1'),
      mensaje: 'solo de proyecto-1',
      autorId: U,
    });
    expect(await almacen.obtener(OTRO_PROYECTO, creada.id)).toBeNull();
  });
});

describe('aislamiento', () => {
  it('dos proyectos no comparten versiones', async () => {
    await almacen.crear({ proyectoId: P, estado: estadoDePrueba('tienda'), mensaje: 'en Tienda', autorId: U });
    await almacen.crear({
      proyectoId: OTRO_PROYECTO,
      estado: estadoDePrueba('clinica'),
      mensaje: 'en Clínica',
      autorId: U,
    });

    const deP = await almacen.listar(P);
    const deOtro = await almacen.listar(OTRO_PROYECTO);

    expect(deP.map((v) => v.mensaje)).toEqual(['en Tienda']);
    expect(deOtro.map((v) => v.mensaje)).toEqual(['en Clínica']);
  });
});

describe('persistencia', () => {
  it('lo guardado, índice y estado, sobrevive a reabrir el almacén', async () => {
    const creada = await almacen.crear({
      proyectoId: P,
      estado: estadoDePrueba('persistente'),
      mensaje: 'sigue aquí',
      autorId: U,
    });
    await almacen.flush();

    const reabierto = new FileVersionStore(dataDir);
    const listado = await reabierto.listar(P);
    expect(listado.map((v) => v.mensaje)).toEqual(['sigue aquí']);

    const version = await reabierto.obtener(P, creada.id);
    expect(new TextDecoder().decode(version!.estado)).toBe('persistente');
  });
});

describe('borrarProyecto', () => {
  it('se lleva el índice y los estados de ese proyecto', async () => {
    const creada = await almacen.crear({ proyectoId: P, estado: estadoDePrueba('v1'), mensaje: 'uno', autorId: U });

    await almacen.borrarProyecto(P);

    expect(await almacen.listar(P)).toEqual([]);
    expect(await almacen.obtener(P, creada.id)).toBeNull();
  });

  it('no toca las versiones de otro proyecto', async () => {
    await almacen.crear({ proyectoId: P, estado: estadoDePrueba('v1'), mensaje: 'en Tienda', autorId: U });
    await almacen.crear({
      proyectoId: OTRO_PROYECTO,
      estado: estadoDePrueba('v2'),
      mensaje: 'en Clínica',
      autorId: U,
    });

    await almacen.borrarProyecto(P);

    expect(await almacen.listar(OTRO_PROYECTO)).toHaveLength(1);
  });
});

describe('identificadores que acaban en una ruta', () => {
  it('un proyecto con travesía falla en vez de escribir fuera', async () => {
    await expect(
      almacen.crear({ proyectoId: '../fuera', estado: estadoDePrueba('v1'), mensaje: 'hola', autorId: U }),
    ).rejects.toThrow(/no admisible/);
  });

  it('listar y obtener con un proyecto inseguro también fallan', async () => {
    await expect(almacen.listar('../fuera')).rejects.toThrow(/no admisible/);
    await expect(almacen.obtener('../fuera', 'id')).rejects.toThrow(/no admisible/);
  });
});
