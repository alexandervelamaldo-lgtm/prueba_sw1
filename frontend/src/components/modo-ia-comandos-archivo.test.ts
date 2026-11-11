import { describe, expect, it } from 'vitest';
import { reconocerAccionDeArchivo } from './modo-ia-comandos-archivo';

/**
 * El caso que motiva este archivo: alguien escribe o dicta «expórtalo en
 * xmi» en el Modo IA y hasta ahora la IA contestaba que no podía. Estas
 * pruebas fijan qué frases disparan la acción y, sobre todo, cuáles no deben
 * hacerlo —una orden de diagrama con «xmi» de paso no es una orden de
 * archivo—.
 */

describe('reconocerAccionDeArchivo', () => {
  it('reconoce la frase exacta que motivó esto, con su errata', () => {
    expect(reconocerAccionDeArchivo('expótalo en xmi')).toBe('exportar-xmi');
  });

  it('reconoce variantes correctas de exportar', () => {
    expect(reconocerAccionDeArchivo('exporta el diagrama a XMI')).toBe('exportar-xmi');
    expect(reconocerAccionDeArchivo('Descarga el xmi')).toBe('exportar-xmi');
    expect(reconocerAccionDeArchivo('genera el xmi del proyecto')).toBe('exportar-xmi');
  });

  it('reconoce importar un xmi', () => {
    expect(reconocerAccionDeArchivo('importa un xmi')).toBe('importar-xmi');
    expect(reconocerAccionDeArchivo('carga el diagrama desde un xmi')).toBe('importar-xmi');
  });

  it('reconoce importar desde una imagen o foto', () => {
    expect(reconocerAccionDeArchivo('importa una foto')).toBe('importar-imagen');
    expect(reconocerAccionDeArchivo('modela desde esta imagen')).toBe('importar-imagen');
    expect(reconocerAccionDeArchivo('lee esta captura de pizarra')).toBe('importar-imagen');
  });

  it('reconoce el pronombre «me» pegado al verbo', () => {
    // El caso que motivó esto: «impórtame desde una foto» no anclaba porque
    // «importa(?:lo|la)?» no cubría «importame».
    expect(reconocerAccionDeArchivo('impórtame desde una foto')).toBe('importar-imagen');
    expect(reconocerAccionDeArchivo('impórtame el xmi')).toBe('importar-xmi');
    expect(reconocerAccionDeArchivo('expórtame a xmi')).toBe('exportar-xmi');
  });

  it('tolera la «r» de «importa»/«expórtame» oída como «s» al dictado', () => {
    // El caso que motivó esto: «impostame desde una foto», tal y como llegó
    // dictado (la «r» de «impórtame» sonó como «s»).
    expect(reconocerAccionDeArchivo('impostame desde una foto')).toBe('importar-imagen');
    expect(reconocerAccionDeArchivo('impostame el xmi')).toBe('importar-xmi');
  });

  it('tolera una muletilla inicial', () => {
    expect(reconocerAccionDeArchivo('por favor exporta a xmi')).toBe('exportar-xmi');
    expect(reconocerAccionDeArchivo('quiero que lo exportes en xmi')).toBe('exportar-xmi');
  });

  it('no reconoce nada si no hay anclaje al verbo inicial', () => {
    // La IA sí entiende esto: no hay que interceptarlo.
    expect(reconocerAccionDeArchivo('crea la clase Xmi')).toBeNull();
  });

  it('no dispara la acción si la orden de diagrama va primero', () => {
    // Una orden encadenada («crea… y expórtalo…») tiene que seguir yendo a
    // la IA completa, no solo a la mitad que reconoce esto.
    expect(reconocerAccionDeArchivo('crea la clase Pedido y expórtalo en xmi')).toBeNull();
  });

  it('no reconoce una orden de diagrama sin verbo de archivo', () => {
    expect(reconocerAccionDeArchivo('crea la clase Cliente con el atributo nombre de tipo texto')).toBeNull();
  });

  it('un texto vacío no reconoce nada', () => {
    expect(reconocerAccionDeArchivo('')).toBeNull();
    expect(reconocerAccionDeArchivo('   ')).toBeNull();
  });
});
