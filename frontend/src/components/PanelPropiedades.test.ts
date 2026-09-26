import { describe, expect, it } from 'vitest';
import {
  type ClassDiagram,
  createAttribute,
  createClass,
  createDiagram,
  createRelation,
} from '@app/shared';
import { clasesElegiblesComoAsociacion, mapeoJpa } from './PanelPropiedades';

/**
 * Pruebas de la lógica de «clase de asociación» del panel de propiedades.
 *
 * Igual que el resto de este proyecto (ver `paneles.test.ts`), no hay jsdom
 * para montar el componente: la lógica que decide qué mostrar se prueba
 * directamente sobre las funciones puras que la calculan.
 */

function diagramaVenta(associationClassId?: string): {
  diagrama: ClassDiagram;
  relacion: ReturnType<typeof createRelation>;
} {
  const venta = createClass({
    id: 'V1',
    name: 'Venta',
    attributes: [createAttribute({ id: 'VA1', name: 'id', type: 'Long', isIdentifier: true })],
  });
  const producto = createClass({
    id: 'V2',
    name: 'Producto',
    attributes: [createAttribute({ id: 'VA2', name: 'id', type: 'Long', isIdentifier: true })],
  });
  const detalle = createClass({
    id: 'V3',
    name: 'DetalleVenta',
    attributes: [createAttribute({ id: 'VA3', name: 'id', type: 'Long', isIdentifier: true })],
  });
  const categoria = createClass({
    id: 'V4',
    name: 'CategoriaInterna',
    kind: 'interface',
  });

  const relacion = createRelation({
    id: 'R1',
    kind: 'association',
    sourceId: venta.id,
    targetId: producto.id,
    sourceMultiplicity: '*',
    targetMultiplicity: '*',
    associationClassId,
  });

  const diagrama = createDiagram({
    id: 'D1',
    name: 'Ventas',
    classes: { V1: venta, V2: producto, V3: detalle, V4: categoria },
    relations: { R1: relacion },
  });

  return { diagrama, relacion };
}

describe('mapeoJpa', () => {
  it('anuncia @ManyToMany con tabla de unión cuando no hay clase de asociación', () => {
    const { diagrama, relacion } = diagramaVenta();
    expect(mapeoJpa(relacion, diagrama)).toBe('@ManyToMany (con tabla de unión)');
  });

  it('anuncia la clase de asociación por su nombre cuando está colgada', () => {
    const { diagrama, relacion } = diagramaVenta('V3');
    expect(mapeoJpa(relacion, diagrama)).toContain('DetalleVenta');
    expect(mapeoJpa(relacion, diagrama)).not.toContain('@ManyToMany');
  });

  it('no cambia el mapeo de una relación que no es N:M solo porque tenga un id colgado a medias', () => {
    // Estado que no debería darse a través de la UI (el desplegable solo sale
    // en relaciones N:M), pero si el documento llegara así por otra vía, el
    // texto no debe fingir un vínculo que el generador no haría: sigue leyendo
    // la cardinalidad real, no el campo `associationClassId`.
    const { diagrama, relacion } = diagramaVenta('V3');
    const unoAMuchos = { ...relacion, source: { ...relacion.source, multiplicity: '1' } };
    expect(mapeoJpa(unoAMuchos, diagrama)).toBe(
      '@OneToMany / @ManyToOne (clave ajena en el lado «muchos»)',
    );
  });
});

describe('clasesElegiblesComoAsociacion', () => {
  it('excluye los dos extremos de la relación', () => {
    const { diagrama, relacion } = diagramaVenta();
    const nombres = clasesElegiblesComoAsociacion(diagrama, relacion).map((c) => c.name);
    expect(nombres).not.toContain('Venta');
    expect(nombres).not.toContain('Producto');
  });

  it('excluye interfaces, porque no se generan como tabla', () => {
    const { diagrama, relacion } = diagramaVenta();
    const nombres = clasesElegiblesComoAsociacion(diagrama, relacion).map((c) => c.name);
    expect(nombres).not.toContain('CategoriaInterna');
  });

  it('ofrece las demás clases persistentes del diagrama', () => {
    const { diagrama, relacion } = diagramaVenta();
    const nombres = clasesElegiblesComoAsociacion(diagrama, relacion).map((c) => c.name);
    expect(nombres).toEqual(['DetalleVenta']);
  });
});
