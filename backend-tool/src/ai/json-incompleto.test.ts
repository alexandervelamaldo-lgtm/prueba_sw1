import { describe, expect, it } from 'vitest';
import { cerrarYParsearJson } from './json-incompleto.js';

describe('cerrarYParsearJson', () => {
  it('cierra una cadena parcial con comillas escapadas', () => {
    expect(cerrarYParsearJson('{"mensaje":"dijo \\"hola\\"')).toEqual({ mensaje: 'dijo "hola"' });
  });

  it('cierra arrays y objetos anidados', () => {
    expect(cerrarYParsearJson('{"acciones":[{"valores":[1,2]}')).toEqual({
      acciones: [{ valores: [1, 2] }],
    });
  });

  it('no inventa el valor de una clave truncada', () => {
    expect(cerrarYParsearJson('{"acciones":[{"_type":"message","te')).toBeNull();
  });

  it('también acepta un JSON completo', () => {
    expect(cerrarYParsearJson('{"ok":true}')).toEqual({ ok: true });
  });
});
