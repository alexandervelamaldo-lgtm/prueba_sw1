import { describe, expect, it } from 'vitest';
import { debeEscucharTrasSaludo, textoDeBienvenida } from './bienvenida-ia';

/**
 * El saludo con el que la IA abre el Modo IA desde el avatar. Se arma en el
 * navegador, sin llamar al modelo: es lo primero que se oye y no puede tardar
 * ni gastar tokens.
 */
const a = (hora: number) => new Date(2026, 9, 18, hora, 0, 0);

describe('textoDeBienvenida', () => {
  it('es corta: un saludo con el nombre y la pregunta, sin enumerar lo que sabe hacer', () => {
    expect(textoDeBienvenida({ nombre: 'Demo', ahora: a(10) })).toBe(
      '¡Buenos días, Demo! ¿En qué te puedo ayudar hoy?',
    );
  });

  it('el saludo depende de la hora del día', () => {
    expect(textoDeBienvenida({ nombre: 'Ana', ahora: a(9) })).toMatch(/^¡Buenos días, Ana!/);
    expect(textoDeBienvenida({ nombre: 'Ana', ahora: a(15) })).toMatch(/^¡Buenas tardes, Ana!/);
    expect(textoDeBienvenida({ nombre: 'Ana', ahora: a(22) })).toMatch(/^¡Buenas noches, Ana!/);
    expect(textoDeBienvenida({ nombre: 'Ana', ahora: a(3) })).toMatch(/^¡Buenas noches, Ana!/);
  });

  it('sin nombre saluda igual, sin dejar una coma colgando', () => {
    expect(textoDeBienvenida({ nombre: '  ', ahora: a(10) })).toMatch(/^¡Buenos días!/);
  });

  it('termina invitando a pedir algo', () => {
    expect(textoDeBienvenida({ nombre: 'Ana', ahora: a(10) })).toMatch(/\?$/);
  });
});

describe('debeEscucharTrasSaludo', () => {
  const listo = { montado: true, soloLectura: false, hayDictado: true, ocupado: false, escuchando: false, hayTexto: false };

  it('tras el saludo, se pone a escuchar', () => {
    expect(debeEscucharTrasSaludo(listo)).toBe(true);
  });

  it('no escucha si ya no hace falta o no se puede', () => {
    expect(debeEscucharTrasSaludo({ ...listo, montado: false })).toBe(false);
    expect(debeEscucharTrasSaludo({ ...listo, soloLectura: true })).toBe(false);
    expect(debeEscucharTrasSaludo({ ...listo, hayDictado: false })).toBe(false);
  });

  it('no le quita la palabra a quien ya empezó: escribiendo, enviando o escuchando', () => {
    expect(debeEscucharTrasSaludo({ ...listo, hayTexto: true })).toBe(false);
    expect(debeEscucharTrasSaludo({ ...listo, ocupado: true })).toBe(false);
    expect(debeEscucharTrasSaludo({ ...listo, escuchando: true })).toBe(false);
  });
});
