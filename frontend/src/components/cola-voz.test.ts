import { describe, expect, it } from 'vitest';
import { crearColaDeVoz } from './cola-voz';

/**
 * La voz del Modo IA en streaming: cada mensaje se dice en cuanto llega, pero
 * sin cortar el anterior. `hablar` es un doble que anota y deja terminar a
 * mano, como haría `speechSynthesis` al acabar una frase.
 */
function dobleDeVoz(notifica = true) {
  const dichas: string[] = [];
  const finales: (() => void)[] = [];
  const hablar = (texto: string, alTerminar?: () => void): boolean => {
    dichas.push(texto);
    if (alTerminar) finales.push(alTerminar);
    return notifica;
  };
  const terminarFrase = (): void => finales.shift()?.();
  return { dichas, hablar, terminarFrase };
}

describe('crearColaDeVoz', () => {
  it('dice el primer mensaje enseguida y el segundo cuando termina el primero', () => {
    const voz = dobleDeVoz();
    const cola = crearColaDeVoz(voz.hablar);

    cola.decir('Creo la clase Pedido.');
    cola.decir('¿Le agrego atributos?');
    expect(voz.dichas).toEqual(['Creo la clase Pedido.']);

    voz.terminarFrase();
    expect(voz.dichas).toEqual(['Creo la clase Pedido.', '¿Le agrego atributos?']);
  });

  it('un mensaje que llega con la voz en silencio se dice enseguida', () => {
    const voz = dobleDeVoz();
    const cola = crearColaDeVoz(voz.hablar);

    cola.decir('Uno.');
    voz.terminarFrase();
    cola.decir('Dos.');

    expect(voz.dichas).toEqual(['Uno.', 'Dos.']);
  });

  it('si la voz no avisa de cuándo termina (puente del móvil), junta lo pendiente y lo dice al final', () => {
    const voz = dobleDeVoz(false);
    const cola = crearColaDeVoz(voz.hablar);

    cola.decir('Uno.');
    cola.decir('Dos.');
    cola.decir('Tres.');
    expect(voz.dichas).toEqual(['Uno.']);

    cola.terminar();
    expect(voz.dichas).toEqual(['Uno.', 'Dos. Tres.']);
  });

  it('vaciar descarta lo pendiente: nada más se dice', () => {
    const voz = dobleDeVoz();
    const cola = crearColaDeVoz(voz.hablar);

    cola.decir('Uno.');
    cola.decir('Dos.');
    cola.vaciar();
    voz.terminarFrase();

    expect(voz.dichas).toEqual(['Uno.']);
  });
});

describe('crearColaDeVoz tras una interrupción', () => {
  it('después de vaciar, lo que llegue ya no se dice: la IA fue interrumpida', () => {
    const voz = dobleDeVoz();
    const cola = crearColaDeVoz(voz.hablar);

    cola.decir('Uno.');
    cola.vaciar();
    cola.decir('Dos.');
    cola.terminar();

    expect(voz.dichas).toEqual(['Uno.']);
  });
});

describe('crearColaDeVoz.cuandoTermine', () => {
  it('avisa cuando terminó de decir todo lo pendiente', () => {
    const voz = dobleDeVoz();
    const cola = crearColaDeVoz(voz.hablar);
    const avisos: string[] = [];

    cola.decir('Uno.');
    cola.decir('Dos.');
    cola.cuandoTermine(() => avisos.push('terminó'));
    voz.terminarFrase();
    expect(avisos).toEqual([]);
    voz.terminarFrase();

    expect(avisos).toEqual(['terminó']);
  });

  it('si no hay nada sonando, avisa enseguida', () => {
    const cola = crearColaDeVoz(dobleDeVoz().hablar);
    const avisos: string[] = [];

    cola.cuandoTermine(() => avisos.push('terminó'));

    expect(avisos).toEqual(['terminó']);
  });

  it('interrumpida, también avisa: ya no queda nada por decir', () => {
    const voz = dobleDeVoz();
    const cola = crearColaDeVoz(voz.hablar);
    const avisos: string[] = [];

    cola.decir('Uno.');
    cola.cuandoTermine(() => avisos.push('terminó'));
    cola.vaciar();

    expect(avisos).toEqual(['terminó']);
  });
});
