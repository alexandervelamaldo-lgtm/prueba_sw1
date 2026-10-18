import { describe, expect, it } from 'vitest';
import { createClass, createDiagram, withClass, type ClassDiagram } from '@app/shared';
import { decidirAccionVoz, resumirPropuesta, textoDeRespuesta, type PropuestaOperacion } from './asistente-voz';

/**
 * Pruebas de la rama que decide si una orden dictada se aplica sola o espera
 * el botón de siempre. Es la mitad de D6 que sí cambia con esta función: la
 * otra mitad —lo escrito a mano siempre espera— no tiene rama que probar,
 * porque no decide nada.
 */

function diagramaConClase(): { diagrama: ClassDiagram; claseId: string } {
  const cliente = createClass({
    name: 'Cliente',
    attributes: [
      { id: 'a1', name: 'nombre', type: { name: 'String', collection: false }, visibility: '-', isStatic: false, isFinal: false, isIdentifier: false, isUnique: false, isNullable: true },
    ],
  });
  return { diagrama: withClass(createDiagram({ name: 'Proyecto' }), cliente), claseId: cliente.id };
}

describe('resumirPropuesta', () => {
  it('con una sola operación, usa su descripción tal cual', () => {
    const propuesta: PropuestaOperacion[] = [
      { operacion: { op: 'addClass', name: 'Pedido', kind: 'class' }, descripcion: 'Crear la clase Pedido' },
    ];
    expect(resumirPropuesta(propuesta)).toBe('Crear la clase Pedido');
  });

  it('con varias, las une con «;»', () => {
    const propuesta: PropuestaOperacion[] = [
      { operacion: { op: 'addClass', name: 'Pedido', kind: 'class' }, descripcion: 'Crear la clase Pedido' },
      {
        operacion: { op: 'addAttribute', classRef: { name: 'Pedido' }, name: 'total', type: 'Double', visibility: '-', isIdentifier: false, isNullable: true, isUnique: false },
        descripcion: 'Añadir el atributo total',
      },
    ];
    expect(resumirPropuesta(propuesta)).toBe('Crear la clase Pedido; Añadir el atributo total');
  });

  it('con la lista vacía, no rompe: devuelve una cadena vacía', () => {
    expect(resumirPropuesta([])).toBe('');
  });
});

describe('decidirAccionVoz', () => {
  it('una operación que no destruye nada se aplica sola', () => {
    const { diagrama } = diagramaConClase();
    const propuesta: PropuestaOperacion[] = [
      {
        operacion: { op: 'addAttribute', classRef: { name: 'Cliente' }, name: 'correo', type: 'String', visibility: '-', isIdentifier: false, isNullable: true, isUnique: false },
        descripcion: 'Añadir el atributo correo a Cliente',
      },
    ];
    const accion = decidirAccionVoz(diagrama, propuesta);
    expect(accion.tipo).toBe('aplicar');
    if (accion.tipo !== 'aplicar') throw new Error('debería aplicarse sola');
    // Lo hablado es corto y no repite lo que se hizo: eso es lo que se ve en
    // pantalla (`detalle`), no lo que hace falta oír para saber que ya se pudo
    // soltar el micrófono.
    expect(accion.anuncio).toBe('Trabajo hecho.');
    expect(accion.detalle).toBe('Hecho: Añadir el atributo correo a Cliente.');
  });

  it('borrar una clase con datos exige confirmar, y el anuncio dice qué se pierde', () => {
    const { diagrama } = diagramaConClase();
    const propuesta: PropuestaOperacion[] = [
      { operacion: { op: 'removeClass', ref: { name: 'Cliente' } }, descripcion: 'Eliminar la clase Cliente' },
    ];
    const accion = decidirAccionVoz(diagrama, propuesta);
    expect(accion.tipo).toBe('confirmar');
    if (accion.tipo !== 'confirmar') throw new Error('debería confirmar');
    expect(accion.anuncio).toContain('Eliminar la clase Cliente');
    expect(accion.anuncio).toContain('la clase «Cliente»');
    expect(accion.anuncio).toContain('Toca aplicar para confirmarlo.');
  });

  it('un lote con una operación destructiva entre varias también exige confirmar', () => {
    const { diagrama } = diagramaConClase();
    const propuesta: PropuestaOperacion[] = [
      { operacion: { op: 'addClass', name: 'Pedido', kind: 'class' }, descripcion: 'Crear la clase Pedido' },
      { operacion: { op: 'removeClass', ref: { name: 'Cliente' } }, descripcion: 'Eliminar la clase Cliente' },
    ];
    expect(decidirAccionVoz(diagrama, propuesta).tipo).toBe('confirmar');
  });

  it('borrar un atributo sin datos igual exige confirmar: destruye el atributo aunque no haya filas', () => {
    const { diagrama } = diagramaConClase();
    const propuesta: PropuestaOperacion[] = [
      { operacion: { op: 'removeAttribute', classRef: { name: 'Cliente' }, attributeName: 'nombre' }, descripcion: 'Eliminar el atributo nombre' },
    ];
    expect(decidirAccionVoz(diagrama, propuesta).tipo).toBe('confirmar');
  });

  it('rellenar una tabla vacía de filas semilla no es destructivo: se aplica sola', () => {
    const { diagrama } = diagramaConClase();
    const propuesta: PropuestaOperacion[] = [
      {
        operacion: { op: 'setSeedRows', classRef: { name: 'Cliente' }, rows: [{ nombre: 'Ana' }] },
        descripcion: 'Cargar datos de ejemplo en Cliente',
      },
    ];
    expect(decidirAccionVoz(diagrama, propuesta).tipo).toBe('aplicar');
  });
});

describe('textoDeRespuesta', () => {
  it('una charla sin operaciones muestra lo que contestó la IA', () => {
    expect(
      textoDeRespuesta({ propuesta: [], aclaracion: null, explicacion: 'A Cliente le falta un email.' }),
    ).toBe('A Cliente le falta un email.');
  });

  it('una aclaración tiene prioridad sobre la explicación', () => {
    expect(
      textoDeRespuesta({ propuesta: [], aclaracion: '¿Qué tipo tiene precio?', explicacion: 'Falta un dato.' }),
    ).toBe('¿Qué tipo tiene precio?');
  });

  it('sin operaciones, sin aclaración y sin texto, pide reformular', () => {
    expect(textoDeRespuesta({ propuesta: [], aclaracion: null, explicacion: '  ' })).toBe(
      'Orden no reconocida. Cabe reformularla con otras palabras.',
    );
  });

  it('con operaciones, devuelve la explicación tal cual', () => {
    const propuesta: PropuestaOperacion[] = [
      { operacion: { op: 'addClass', name: 'Pedido', kind: 'class' }, descripcion: 'Crear la clase Pedido' },
    ];
    expect(textoDeRespuesta({ propuesta, aclaracion: null, explicacion: 'Creo Pedido.' })).toBe('Creo Pedido.');
  });
});
