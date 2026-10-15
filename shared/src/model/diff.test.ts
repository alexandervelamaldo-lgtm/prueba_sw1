import { describe, expect, it } from 'vitest';
import { diffDiagramas, hayDiferencias } from './diff.js';
import { createAttribute, createClass, createDiagram, createMethod, createRelation, withClass, withRelation } from './factory.js';

describe('diffDiagramas', () => {
  it('no reporta diferencias entre dos copias del mismo diagrama', () => {
    const cliente = createClass({ name: 'Cliente', attributes: [createAttribute({ name: 'nombre', type: 'String' })] });
    const diagrama = withClass(createDiagram({ name: 'Ventas' }), cliente);
    const diferencia = diffDiagramas(diagrama, diagrama);
    expect(hayDiferencias(diferencia)).toBe(false);
    expect(diferencia.clases).toEqual([]);
    expect(diferencia.relaciones).toEqual([]);
    expect(diferencia.modulos).toEqual([]);
    expect(diferencia.meta).toEqual([]);
  });

  it('detecta una clase añadida y una eliminada', () => {
    const cliente = createClass({ name: 'Cliente' });
    const pedido = createClass({ name: 'Pedido' });
    const anterior = withClass(createDiagram({ name: 'Ventas' }), cliente);
    const actual = withClass(createDiagram({ name: 'Ventas' }), pedido);

    const diferencia = diffDiagramas(anterior, actual);

    expect(diferencia.clases).toHaveLength(2);
    const porTipo = Object.fromEntries(diferencia.clases.map((c) => [c.tipo, c.nombre]));
    expect(porTipo.añadido).toBe('Pedido');
    expect(porTipo.eliminado).toBe('Cliente');
  });

  it('no reporta una clase común sin cambios reales', () => {
    const cliente = createClass({ name: 'Cliente', id: 'c1' });
    const anterior = withClass(createDiagram({ name: 'Ventas' }), cliente);
    const actual = withClass(createDiagram({ name: 'Ventas' }), { ...cliente });

    const diferencia = diffDiagramas(anterior, actual);
    expect(diferencia.clases).toEqual([]);
  });

  it('detecta el renombrado y el cambio de tipo de una clase', () => {
    const cliente = createClass({ name: 'Cliente', id: 'c1', kind: 'class' });
    const anterior = withClass(createDiagram({ name: 'Ventas' }), cliente);
    const actual = withClass(createDiagram({ name: 'Ventas' }), { ...cliente, name: 'ClienteVip', kind: 'abstract' });

    const diferencia = diffDiagramas(anterior, actual);

    expect(diferencia.clases).toHaveLength(1);
    const cambio = diferencia.clases[0]!;
    expect(cambio.tipo).toBe('modificado');
    expect(cambio.campos).toContainEqual({ campo: 'nombre', antes: 'Cliente', despues: 'ClienteVip' });
    expect(cambio.campos).toContainEqual({ campo: 'tipo', antes: 'clase', despues: 'clase abstracta' });
  });

  it('detecta atributos añadidos, eliminados y modificados dentro de una misma clase', () => {
    const correo = createAttribute({ id: 'a1', name: 'correo', type: 'String' });
    const telefono = createAttribute({ id: 'a2', name: 'telefono', type: 'String' });
    const cliente = createClass({ id: 'c1', name: 'Cliente', attributes: [correo, telefono] });
    const anterior = withClass(createDiagram({ name: 'Ventas' }), cliente);

    const clienteModificado = createClass({
      id: 'c1',
      name: 'Cliente',
      attributes: [
        { ...correo, isUnique: true },
        createAttribute({ id: 'a3', name: 'direccion', type: 'String' }),
      ],
    });
    const actual = withClass(createDiagram({ name: 'Ventas' }), clienteModificado);

    const diferencia = diffDiagramas(anterior, actual);
    expect(diferencia.clases).toHaveLength(1);
    const cambio = diferencia.clases[0]!;
    expect(cambio.atributosEliminados).toHaveLength(1);
    expect(cambio.atributosEliminados[0]).toContain('telefono');
    expect(cambio.atributosAñadidos).toHaveLength(1);
    expect(cambio.atributosAñadidos[0]).toContain('direccion');
    expect(cambio.atributosModificados).toHaveLength(1);
    expect(cambio.atributosModificados[0]!.campo).toBe('correo');
  });

  it('detecta métodos añadidos, eliminados y modificados', () => {
    const guardar = createMethod({ id: 'm1', name: 'guardar' });
    const cliente = createClass({ id: 'c1', name: 'Cliente', methods: [guardar] });
    const anterior = withClass(createDiagram({ name: 'Ventas' }), cliente);

    const clienteModificado = createClass({
      id: 'c1',
      name: 'Cliente',
      methods: [{ ...guardar, isAbstract: true }, createMethod({ id: 'm2', name: 'eliminar' })],
    });
    const actual = withClass(createDiagram({ name: 'Ventas' }), clienteModificado);

    const diferencia = diffDiagramas(anterior, actual);
    const cambio = diferencia.clases[0]!;
    expect(cambio.metodosAñadidos.some((m) => m.includes('eliminar'))).toBe(true);
    expect(cambio.metodosModificados).toHaveLength(1);
    expect(cambio.metodosModificados[0]!.campo).toBe('guardar');
  });

  it('detecta literales añadidos y eliminados en una enumeración', () => {
    const estado = createClass({ id: 'c1', name: 'Estado', kind: 'enum', literals: ['ACTIVO', 'INACTIVO'] });
    const anterior = withClass(createDiagram({ name: 'Ventas' }), estado);
    const actual = withClass(createDiagram({ name: 'Ventas' }), { ...estado, literals: ['ACTIVO', 'ARCHIVADO'] });

    const diferencia = diffDiagramas(anterior, actual);
    const cambio = diferencia.clases[0]!;
    expect(cambio.literalesAñadidos).toEqual(['ARCHIVADO']);
    expect(cambio.literalesEliminados).toEqual(['INACTIVO']);
  });

  it('detecta relaciones añadidas, eliminadas y modificadas', () => {
    const cliente = createClass({ id: 'c1', name: 'Cliente' });
    const pedido = createClass({ id: 'c2', name: 'Pedido' });
    const factura = createClass({ id: 'c3', name: 'Factura' });
    const relacionVieja = createRelation({
      id: 'r1',
      kind: 'association',
      sourceId: 'c1',
      targetId: 'c2',
      sourceMultiplicity: '1',
      targetMultiplicity: '*',
    });
    const relacionQueCambia = createRelation({
      id: 'r2',
      kind: 'association',
      sourceId: 'c1',
      targetId: 'c3',
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
    });

    let anterior = createDiagram({ name: 'Ventas' });
    anterior = withClass(anterior, cliente);
    anterior = withClass(anterior, pedido);
    anterior = withClass(anterior, factura);
    anterior = withRelation(anterior, relacionVieja);
    anterior = withRelation(anterior, relacionQueCambia);

    const relacionNueva = createRelation({ id: 'r3', kind: 'composition', sourceId: 'c1', targetId: 'c3' });
    let actual = createDiagram({ name: 'Ventas' });
    actual = withClass(actual, cliente);
    actual = withClass(actual, pedido);
    actual = withClass(actual, factura);
    actual = withRelation(actual, {
      ...relacionQueCambia,
      kind: 'composition',
      target: { ...relacionQueCambia.target, multiplicity: '*' },
    });
    actual = withRelation(actual, relacionNueva);

    const diferencia = diffDiagramas(anterior, actual);
    expect(diferencia.relaciones).toHaveLength(3);
    const porId = Object.fromEntries(diferencia.relaciones.map((r) => [r.id, r]));
    expect(porId.r1!.tipo).toBe('eliminado');
    expect(porId.r3!.tipo).toBe('añadido');
    expect(porId.r2!.tipo).toBe('modificado');
    expect(porId.r2!.campos.some((c) => c.campo === 'tipo')).toBe(true);
    expect(porId.r2!.campos.some((c) => c.campo === 'destino')).toBe(true);
  });

  it('detecta módulos añadidos, eliminados y modificados', () => {
    const anterior = createDiagram({
      name: 'Ventas',
      modules: {
        m1: { id: 'm1', name: 'inventario', packageSegment: 'inventario', description: '' },
        m2: { id: 'm2', name: 'ventas', packageSegment: 'ventas', description: '' },
      },
    });
    const actual = createDiagram({
      name: 'Ventas',
      modules: {
        m2: { id: 'm2', name: 'ventas', packageSegment: 'comercial', description: '' },
        m3: { id: 'm3', name: 'soporte', packageSegment: 'soporte', description: '' },
      },
    });

    const diferencia = diffDiagramas(anterior, actual);
    const porId = Object.fromEntries(diferencia.modulos.map((m) => [m.id, m]));
    expect(porId.m1!.tipo).toBe('eliminado');
    expect(porId.m3!.tipo).toBe('añadido');
    expect(porId.m2!.tipo).toBe('modificado');
    expect(porId.m2!.campos).toContainEqual({
      campo: 'segmento de paquete',
      antes: 'ventas',
      despues: 'comercial',
    });
  });

  it('detecta cambios en los metadatos del diagrama, sin incluir las marcas de tiempo', () => {
    const anterior = createDiagram({
      name: 'Ventas',
      meta: { basePackage: 'com.ejemplo.a', motorBD: 'postgres', createdAt: '2024-01-01' },
    });
    const actual = createDiagram({
      name: 'Ventas',
      meta: { basePackage: 'com.ejemplo.b', motorBD: 'mongodb', createdAt: '2024-06-01' },
    });

    const diferencia = diffDiagramas(anterior, actual);
    expect(diferencia.meta).toContainEqual({
      campo: 'paquete base',
      antes: 'com.ejemplo.a',
      despues: 'com.ejemplo.b',
    });
    expect(diferencia.meta).toContainEqual({
      campo: 'motor de base de datos',
      antes: 'PostgreSQL',
      despues: 'MongoDB',
    });
    expect(diferencia.meta.some((c) => c.campo.includes('fecha'))).toBe(false);
  });
});
