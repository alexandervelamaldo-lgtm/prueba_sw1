import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileUsoIAStore, diaDeHoy } from '../storage/uso-ia.js';
import { CupoIA } from './cupo-ia.js';

/**
 * El cupo diario de la IA con pedidos a la vez: lo que hay que sujetar es que
 * varios pedidos simultáneos no pasen todos con el mismo cupo, y que lo
 * gastado de verdad se sume una vez al terminar.
 */

let dataDir: string;
let uso: FileUsoIAStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'uml-cupo-ia-'));
  uso = new FileUsoIAStore(dataDir);
});

afterEach(async () => {
  await uso.flush();
  await rm(dataDir, { recursive: true, force: true });
});

describe('CupoIA', () => {
  it('pedidos a la vez cuentan las reservas de los que siguen en curso: el exceso queda en un pedido', async () => {
    const cupo = new CupoIA(uso, 5000, 3000);

    const reservas = await Promise.all([cupo.reservar('ana'), cupo.reservar('ana'), cupo.reservar('ana')]);

    // 0 y 3000 apartados no llegan a 5000; con 6000 apartados ya no hay cupo.
    expect(reservas.map((r) => r !== null)).toEqual([true, true, false]);
  });

  it('al cerrar se libera la reserva y se suma lo gastado de verdad, una sola vez', async () => {
    const cupo = new CupoIA(uso, 5000, 3000);
    const reserva = (await cupo.reservar('ana'))!;

    reserva.registrar(100);
    reserva.registrar(20);
    await reserva.cerrar();
    await reserva.cerrar();

    expect(await uso.leer('ana', diaDeHoy())).toBe(120);
    expect(await cupo.reservar('ana')).not.toBeNull();
  });

  it('con lo gastado en el límite no hay cupo', async () => {
    const cupo = new CupoIA(uso, 5000, 3000);
    await uso.sumar('ana', diaDeHoy(), 5000);

    expect(await cupo.reservar('ana')).toBeNull();
  });

  it('el cupo es de cada usuario', async () => {
    const cupo = new CupoIA(uso, 5000, 3000);
    await cupo.reservar('ana');

    expect(await cupo.reservar('beto')).not.toBeNull();
  });

  it('sin límite siempre hay cupo, y aun así se cuenta lo gastado', async () => {
    const cupo = new CupoIA(uso, undefined, 3000);
    const reservas = await Promise.all([cupo.reservar('ana'), cupo.reservar('ana')]);

    for (const reserva of reservas) {
      reserva!.registrar(10);
      await reserva!.cerrar();
    }

    expect(await uso.leer('ana', diaDeHoy())).toBe(20);
  });
});
