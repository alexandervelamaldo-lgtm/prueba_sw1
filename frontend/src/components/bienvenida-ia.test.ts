import { describe, expect, it } from 'vitest';
import { textoDeBienvenida } from './bienvenida-ia';

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
