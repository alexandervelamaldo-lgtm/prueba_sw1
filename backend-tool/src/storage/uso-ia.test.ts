import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileUsoIAStore } from './uso-ia.js';

/**
 * El uso de la IA por usuario y día, contra el disco de verdad: es lo que
 * decide si alguien llegó a su límite diario (`LLM_LIMITE_DIARIO_TOKENS`).
 */

let dataDir: string;
let almacen: FileUsoIAStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'uml-uso-ia-'));
  almacen = new FileUsoIAStore(dataDir);
});

afterEach(async () => {
  await almacen.flush();
  await rm(dataDir, { recursive: true, force: true });
});

describe('FileUsoIAStore', () => {
  it('sin uso registrado, el día está en cero', async () => {
    expect(await almacen.leer('ana', '2026-10-17')).toBe(0);
  });

  it('suma lo de cada petición y devuelve el total del día', async () => {
    expect(await almacen.sumar('ana', '2026-10-17', 120)).toBe(120);
    expect(await almacen.sumar('ana', '2026-10-17', 30)).toBe(150);
    expect(await almacen.leer('ana', '2026-10-17')).toBe(150);
  });

  it('cada usuario y cada día por separado', async () => {
    await almacen.sumar('ana', '2026-10-17', 100);
    await almacen.sumar('beto', '2026-10-17', 7);
    await almacen.sumar('ana', '2026-10-18', 5);

    expect(await almacen.leer('beto', '2026-10-17')).toBe(7);
    expect(await almacen.leer('ana', '2026-10-18')).toBe(5);
  });

  it('sobrevive a reabrir el almacén', async () => {
    await almacen.sumar('ana', '2026-10-17', 42);
    await almacen.flush();

    expect(await new FileUsoIAStore(dataDir).leer('ana', '2026-10-17')).toBe(42);
  });

  it('solo guarda los últimos 31 días de cada usuario', async () => {
    await almacen.sumar('ana', '2026-08-01', 9);
    await almacen.sumar('ana', '2026-10-17', 1);

    expect(await almacen.leer('ana', '2026-08-01')).toBe(0);
    expect(await almacen.leer('ana', '2026-10-17')).toBe(1);
  });

  it('una cantidad negativa o no entera no resta ni rompe el total', async () => {
    await almacen.sumar('ana', '2026-10-17', 10);
    await almacen.sumar('ana', '2026-10-17', -5);
    await almacen.sumar('ana', '2026-10-17', 2.6);

    expect(await almacen.leer('ana', '2026-10-17')).toBe(13);
  });
});

describe('FileUsoIAStore con peticiones a la vez', () => {
  it('dos sumas antes de la primera lectura del fichero no se pisan', async () => {
    await almacen.sumar('ana', '2026-10-17', 1);
    await almacen.flush();
    const reabierto = new FileUsoIAStore(dataDir);

    await Promise.all([reabierto.sumar('ana', '2026-10-17', 10), reabierto.sumar('ana', '2026-10-17', 20)]);

    expect(await reabierto.leer('ana', '2026-10-17')).toBe(31);
    await reabierto.flush();
  });
});

describe('FileUsoIAStore no crece con usuarios inactivos', () => {
  it('al sumar, se olvidan los días viejos de todos los usuarios, no solo del que suma', async () => {
    await almacen.sumar('beto', '2026-08-01', 9);
    await almacen.sumar('ana', '2026-10-17', 1);

    expect(await almacen.leer('beto', '2026-08-01')).toBe(0);
  });
});
