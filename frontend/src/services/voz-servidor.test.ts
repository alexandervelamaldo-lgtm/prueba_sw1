import { describe, expect, it } from 'vitest';
import { crearVozDelServidor, type ReproductorAudio } from './voz-servidor';

/**
 * La voz del servidor (ElevenLabs) en el navegador, con el pedido del audio y
 * el reproductor de mentira: lo que se sujeta es cuándo avisa del final,
 * cuándo cae a la voz del navegador y que callar de verdad corte.
 */
function preparar(opciones: { falla?: 'red' | 'sin-voz' } = {}) {
  const reproductores: (ReproductorAudio & { terminar(): void; pausado: boolean })[] = [];
  const pedidos: string[] = [];
  const voz = crearVozDelServidor({
    pedirAudio: async (texto) => {
      pedidos.push(texto);
      if (opciones.falla === 'sin-voz') throw Object.assign(new Error('503'), { status: 503 });
      if (opciones.falla === 'red') throw new Error('sin red');
      return new Blob(['mp3']);
    },
    crearReproductor: () => {
      let alTerminar: (() => void) | null = null;
      const reproductor = {
        pausado: false,
        play: async () => {},
        pause() {
          reproductor.pausado = true;
        },
        set onended(fn: (() => void) | null) {
          alTerminar = fn;
        },
        get onended() {
          return alTerminar;
        },
        onerror: null,
        terminar() {
          alTerminar?.();
        },
      };
      reproductores.push(reproductor);
      return reproductor;
    },
    crearUrl: () => 'blob:x',
    liberarUrl: () => {},
  });
  return { voz, reproductores, pedidos };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('crearVozDelServidor', () => {
  it('pide el audio, lo reproduce y avisa al terminar', async () => {
    const { voz, reproductores, pedidos } = preparar();
    const finales: string[] = [];

    voz.hablar('Hola.', () => finales.push('fin'), () => finales.push('navegador'));
    await tick();
    reproductores[0]!.terminar();

    expect(pedidos).toEqual(['Hola.']);
    expect(finales).toEqual(['fin']);
  });

  it('si falla, cae a la voz del navegador una sola vez', async () => {
    const { voz } = preparar({ falla: 'red' });
    const finales: string[] = [];

    voz.hablar('Hola.', () => finales.push('fin'), () => finales.push('navegador'));
    await tick();

    expect(finales).toEqual(['navegador']);
    expect(voz.activa).toBe(true);
  });

  it('si el servidor dice que no hay voz (503), deja de intentarlo en la sesión', async () => {
    const { voz } = preparar({ falla: 'sin-voz' });

    voz.hablar('Hola.', () => {}, () => {});
    await tick();

    expect(voz.activa).toBe(false);
  });

  it('callar corta lo que suena y lo que todavía se está pidiendo, sin avisar ni caer al navegador', async () => {
    const { voz, reproductores } = preparar();
    const finales: string[] = [];

    voz.hablar('Uno.', () => finales.push('fin uno'), () => finales.push('navegador'));
    await tick();
    voz.callar();
    reproductores[0]!.terminar();
    voz.hablar('Dos.', () => finales.push('fin dos'), () => finales.push('navegador'));
    voz.callar();
    await tick();

    expect(reproductores[0]!.pausado).toBe(true);
    expect(reproductores).toHaveLength(1);
    expect(finales).toEqual([]);
  });
});
