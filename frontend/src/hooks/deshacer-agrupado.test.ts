import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { crearAgrupadorDeshacer } from './deshacer-agrupado';

/**
 * Contra un `Y.UndoManager` de verdad: lo que se comprueba es justo cómo Yjs
 * decide cuándo dos cambios son un solo paso de deshacer. Con
 * `captureTimeout: 0`, fuera de un grupo cada cambio es su propio paso, así
 * que la prueba no depende de cuánto tarde en ejecutarse.
 */
function preparar() {
  const doc = new Y.Doc();
  const mapa = doc.getMap('clases');
  const origen = Symbol('local');
  const manager = new Y.UndoManager([mapa], { trackedOrigins: new Set([origen]), captureTimeout: 0 });
  const agrupador = crearAgrupadorDeshacer(() => manager);
  const cambiar = (clave: string): void => {
    doc.transact(() => {
      mapa.set(clave, true);
    }, origen);
  };
  /** Un cambio hecho a mano: pasa por `ajeno`, como todo `aplicar` de `useDiagrama`. */
  const aMano = (clave: string): void => agrupador.ajeno(() => cambiar(clave));
  return { mapa, manager, agrupador, cambiar, aMano };
}

describe('crearAgrupadorDeshacer', () => {
  it('los cambios propios del grupo se deshacen de una vez', () => {
    const { mapa, manager, agrupador, cambiar } = preparar();

    const grupo = agrupador.abrir();
    grupo.propio(() => cambiar('Pedido'));
    grupo.propio(() => cambiar('Linea'));
    grupo.cerrar();

    expect(manager.undoStack).toHaveLength(1);
    manager.undo();
    expect(mapa.size).toBe(0);
  });

  it('el grupo no se mezcla con el cambio anterior ni con el siguiente', () => {
    const { mapa, manager, agrupador, cambiar, aMano } = preparar();

    aMano('Cliente');
    const grupo = agrupador.abrir();
    grupo.propio(() => cambiar('Pedido'));
    grupo.cerrar();
    aMano('Factura');

    expect(manager.undoStack).toHaveLength(3);
    manager.undo();
    manager.undo();
    expect([...mapa.keys()]).toEqual(['Cliente']);
  });

  it('un cambio a mano en medio del grupo es su propio paso: deshacer la IA no se lo lleva', () => {
    const { mapa, manager, agrupador, cambiar, aMano } = preparar();

    const grupo = agrupador.abrir();
    grupo.propio(() => cambiar('Pedido'));
    aMano('Mio');
    grupo.propio(() => cambiar('Linea'));
    grupo.cerrar();

    // Pedido | Mio | Linea: la respuesta de la IA queda partida en dos, pero
    // ningún paso mezcla lo de la IA con lo de la persona.
    expect(manager.undoStack).toHaveLength(3);
    manager.undo();
    expect(mapa.has('Linea')).toBe(false);
    expect(mapa.has('Mio')).toBe(true);
  });

  it('al cerrar devuelve la ventana de captura que tenía el gestor', () => {
    const { manager, agrupador } = preparar();

    agrupador.abrir().cerrar();

    expect(manager.captureTimeout).toBe(0);
  });

  it('dos grupos anidados: solo el último en cerrarse devuelve la ventana', () => {
    const { manager, agrupador } = preparar();

    const fuera = agrupador.abrir();
    const dentro = agrupador.abrir();
    dentro.cerrar();
    expect(manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
    fuera.cerrar();

    expect(manager.captureTimeout).toBe(0);
  });

  it('cerrar dos veces el mismo grupo no cierra el de otro', () => {
    const { manager, agrupador } = preparar();

    const fuera = agrupador.abrir();
    const dentro = agrupador.abrir();
    dentro.cerrar();
    dentro.cerrar();

    expect(manager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
    fuera.cerrar();
    expect(manager.captureTimeout).toBe(0);
  });

  it('sin gestor todavía, abrir y cerrar no hace nada y lo propio se ejecuta igual', () => {
    const agrupador = crearAgrupadorDeshacer(() => null);
    const grupo = agrupador.abrir();

    expect(grupo.propio(() => 42)).toBe(42);
    expect(() => grupo.cerrar()).not.toThrow();
  });
});
