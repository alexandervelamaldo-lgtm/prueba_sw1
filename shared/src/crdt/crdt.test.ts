import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getClassesMap, initializeEmpty, readDiagram } from './document.js';
import { applyOperation, applyOperations } from './operations.js';
import { describeOperation, type Operation } from '../ops/operations.js';
import { isToMany } from '../model/uml.js';

function nuevoDoc(): Y.Doc {
  const doc = new Y.Doc();
  initializeEmpty(doc, {
    name: 'Prueba',
    basePackage: 'com.ejemplo.prueba',
    artifactId: 'prueba',
  });
  return doc;
}

/** Crea una clase y devuelve su identificador, para no repetirlo en cada prueba. */
function crearClase(doc: Y.Doc, name: string, kind: 'class' | 'enum' = 'class'): string {
  const result = applyOperation(doc, { op: 'addClass', name, kind });
  if (!result.ok || !result.classId) throw new Error(`no se pudo crear ${name}`);
  return result.classId;
}

/** Atributo de texto sin más adornos, que es lo que piden casi todas las pruebas. */
function atributoDe(clase: string, name: string): Operation {
  return {
    op: 'addAttribute',
    classRef: { name: clase },
    name,
    type: 'String',
    visibility: '-',
    isIdentifier: false,
    isNullable: true,
    isUnique: false,
  };
}

describe('applyOperation', () => {
  it('crea una clase con posición libre y la deja legible', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');

    const diagrama = readDiagram(doc);
    const clases = Object.values(diagrama.classes);
    expect(clases).toHaveLength(1);
    expect(clases[0]?.name).toBe('Cliente');
  });

  it('no apila las clases nuevas en el mismo punto', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Uno');
    crearClase(doc, 'Dos');

    const [uno, dos] = Object.values(readDiagram(doc).classes);
    expect(uno?.position).not.toEqual(dos?.position);
  });

  it('resuelve la clase por nombre sin distinguir mayúsculas', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');

    const result = applyOperation(doc, {
      op: 'addAttribute',
      classRef: { name: 'cliente' },
      name: 'correo',
      type: 'String',
      visibility: '-',
      isIdentifier: false,
      isNullable: true,
      isUnique: false,
    });

    expect(result.ok).toBe(true);
  });

  it('se niega a elegir cuando el nombre es ambiguo', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');
    crearClase(doc, 'Cliente');

    const result = applyOperation(doc, { op: 'removeClass', ref: { name: 'Cliente' } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/2 clases/);
  });

  it('un identificador nunca queda anulable, aunque se pida', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');
    applyOperation(doc, {
      op: 'addAttribute',
      classRef: { name: 'Cliente' },
      name: 'id',
      type: 'Long',
      visibility: '-',
      isIdentifier: true,
      isNullable: true,
      isUnique: false,
    });

    const cliente = Object.values(readDiagram(doc).classes)[0];
    expect(cliente?.attributes[0]?.isNullable).toBe(false);
  });

  it('rechaza un atributo repetido en la misma clase', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');
    const atributo: Operation = {
      op: 'addAttribute',
      classRef: { name: 'Cliente' },
      name: 'correo',
      type: 'String',
      visibility: '-',
      isIdentifier: false,
      isNullable: true,
      isUnique: false,
    };

    expect(applyOperation(doc, atributo).ok).toBe(true);
    expect(applyOperation(doc, atributo).ok).toBe(false);
  });

  it('al borrar una clase arrastra las relaciones que la tocaban', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');
    crearClase(doc, 'Pedido');
    applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Cliente' },
      target: { name: 'Pedido' },
      sourceMultiplicity: '1',
      targetMultiplicity: '*',
    });

    expect(Object.keys(readDiagram(doc).relations)).toHaveLength(1);

    applyOperation(doc, { op: 'removeClass', ref: { name: 'Pedido' } });
    expect(Object.keys(readDiagram(doc).relations)).toHaveLength(0);
  });

  it('impide que la herencia forme un ciclo', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'A');
    crearClase(doc, 'B');
    crearClase(doc, 'C');

    const heredar = (hijo: string, padre: string): Operation => ({
      op: 'addRelation',
      kind: 'inheritance',
      source: { name: hijo },
      target: { name: padre },
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
    });

    expect(applyOperation(doc, heredar('B', 'A')).ok).toBe(true);
    expect(applyOperation(doc, heredar('C', 'B')).ok).toBe(true);

    const ciclo = applyOperation(doc, heredar('A', 'C'));
    expect(ciclo.ok).toBe(false);
    expect(ciclo.ok === false && ciclo.error).toMatch(/ciclo/);
  });

  it('guarda las filas de datos de ejemplo y las devuelve al leer', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Empleado');
    applyOperation(doc, atributoDe('Empleado', 'nombre'));

    const result = applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ nombre: 'Ana' }, { nombre: 'Luis' }],
    });

    expect(result.ok).toBe(true);
    const empleado = Object.values(readDiagram(doc).classes)[0];
    expect(empleado?.seedRows).toEqual([{ nombre: 'Ana' }, { nombre: 'Luis' }]);
  });

  it('setSeedRows sustituye, no acumula', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Empleado');
    applyOperation(doc, atributoDe('Empleado', 'nombre'));

    applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ nombre: 'Ana' }, { nombre: 'Luis' }],
    });
    applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ nombre: 'Marta' }],
    });

    expect(Object.values(readDiagram(doc).classes)[0]?.seedRows).toEqual([{ nombre: 'Marta' }]);
  });

  it('rechaza una fila cuya columna no es atributo de la clase', () => {
    // Es la señal de una importación mal mapeada. Guardarla dejaría datos que el
    // generador ignora en silencio y que el usuario da por escritos.
    const doc = nuevoDoc();
    crearClase(doc, 'Empleado');
    applyOperation(doc, atributoDe('Empleado', 'nombre'));

    const result = applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ nombre: 'Ana', sueldo: '1000' }],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/sueldo/);
    expect(Object.values(readDiagram(doc).classes)[0]?.seedRows).toEqual([]);
  });

  it('no admite datos en una enumeración, que no se materializa como tabla', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Estado', 'enum');

    const result = applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Estado' },
      rows: [{ nombre: 'ALTA' }],
    });

    expect(result.ok).toBe(false);
  });

  it('borra la fila indicada contando desde uno, como se dice al dictarla', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Empleado');
    applyOperation(doc, atributoDe('Empleado', 'nombre'));
    applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ nombre: 'Ana' }, { nombre: 'Luis' }, { nombre: 'Marta' }],
    });

    expect(applyOperation(doc, {
      op: 'removeSeedRow',
      classRef: { name: 'Empleado' },
      index: 2,
    }).ok).toBe(true);

    expect(Object.values(readDiagram(doc).classes)[0]?.seedRows).toEqual([
      { nombre: 'Ana' },
      { nombre: 'Marta' },
    ]);
  });

  it('se queja en vez de borrar otra cosa si la fila pedida no existe', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Empleado');
    applyOperation(doc, atributoDe('Empleado', 'nombre'));
    applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ nombre: 'Ana' }],
    });

    const result = applyOperation(doc, {
      op: 'removeSeedRow',
      classRef: { name: 'Empleado' },
      index: 5,
    });

    expect(result.ok).toBe(false);
    expect(Object.values(readDiagram(doc).classes)[0]?.seedRows).toHaveLength(1);
  });

  it('las filas se mantienen sin desplazarse al borrar un atributo', () => {
    // La razón de que las filas se guarden por nombre de columna y no por
    // posición: borrar la primera columna no debe correr los demás valores.
    const doc = nuevoDoc();
    crearClase(doc, 'Empleado');
    applyOperation(doc, atributoDe('Empleado', 'codigo'));
    applyOperation(doc, atributoDe('Empleado', 'nombre'));
    applyOperation(doc, {
      op: 'setSeedRows',
      classRef: { name: 'Empleado' },
      rows: [{ codigo: 'A1', nombre: 'Ana' }],
    });

    applyOperation(doc, {
      op: 'removeAttribute',
      classRef: { name: 'Empleado' },
      attributeName: 'codigo',
    });

    const fila = Object.values(readDiagram(doc).classes)[0]?.seedRows[0];
    expect(fila?.nombre).toBe('Ana');
  });

  it('solo admite literales en una enumeración', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Estado', 'enum');
    crearClase(doc, 'Cliente');

    expect(
      applyOperation(doc, { op: 'addEnumLiteral', classRef: { name: 'Estado' }, literal: 'ALTA' })
        .ok,
    ).toBe(true);
    expect(
      applyOperation(doc, { op: 'addEnumLiteral', classRef: { name: 'Cliente' }, literal: 'ALTA' })
        .ok,
    ).toBe(false);
  });

  it('informa sin romper nada cuando la clase no existe', () => {
    const doc = nuevoDoc();
    const result = applyOperation(doc, { op: 'removeClass', ref: { name: 'Fantasma' } });

    expect(result.ok).toBe(false);
    expect(Object.keys(readDiagram(doc).classes)).toHaveLength(0);
  });
});

describe('applyOperations', () => {
  it('deja el diagrama intacto si una operación del lote falla', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');
    const antes = readDiagram(doc);

    const result = applyOperations(doc, [
      { op: 'addClass', name: 'Pedido', kind: 'class' },
      { op: 'addClass', name: 'Factura', kind: 'class' },
      { op: 'removeClass', ref: { name: 'NoExiste' } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failedAt).toBe(2);
    // Ni Pedido ni Factura deben haber sobrevivido al fallo posterior.
    expect(Object.keys(readDiagram(doc).classes)).toEqual(Object.keys(antes.classes));
  });

  it('aplica el lote entero cuando todas las operaciones son válidas', () => {
    const doc = nuevoDoc();
    const result = applyOperations(doc, [
      { op: 'addClass', name: 'Cliente', kind: 'class' },
      { op: 'addClass', name: 'Pedido', kind: 'class' },
      {
        op: 'addRelation',
        kind: 'association',
        source: { name: 'Cliente' },
        target: { name: 'Pedido' },
        sourceMultiplicity: '1',
        targetMultiplicity: '*',
      },
    ]);

    expect(result.ok).toBe(true);
    const diagrama = readDiagram(doc);
    expect(Object.keys(diagrama.classes)).toHaveLength(2);
    expect(Object.keys(diagrama.relations)).toHaveLength(1);
  });
});

describe('convergencia', () => {
  /**
   * Es la propiedad por la que se eligió un CRDT (decisión D1): dos personas
   * editando a la vez, cada una sin ver lo de la otra, terminan con el mismo
   * diagrama sin que nadie resuelva un conflicto a mano.
   */
  it('dos réplicas que editan a ciegas acaban iguales', () => {
    const ana = nuevoDoc();
    crearClase(ana, 'Cliente');

    const beto = new Y.Doc();
    Y.applyUpdate(beto, Y.encodeStateAsUpdate(ana));

    applyOperation(ana, {
      op: 'addAttribute',
      classRef: { name: 'Cliente' },
      name: 'correo',
      type: 'String',
      visibility: '-',
      isIdentifier: false,
      isNullable: true,
      isUnique: false,
    });
    applyOperation(beto, { op: 'addClass', name: 'Pedido', kind: 'class' });

    // Intercambio en ambos sentidos, como haría la reconexión.
    const deAna = Y.encodeStateAsUpdate(ana, Y.encodeStateVector(beto));
    const deBeto = Y.encodeStateAsUpdate(beto, Y.encodeStateVector(ana));
    Y.applyUpdate(beto, deAna);
    Y.applyUpdate(ana, deBeto);

    const final = readDiagram(ana);
    expect(readDiagram(beto)).toEqual(final);
    expect(Object.keys(final.classes)).toHaveLength(2);

    const cliente = Object.values(final.classes).find((c) => c.name === 'Cliente');
    expect(cliente?.attributes.map((a) => a.name)).toEqual(['correo']);
  });

  /**
   * Regresión de un defecto que borraba diagramas enteros.
   *
   * Los mapas del documento se creaban al vuelo la primera vez que alguien los
   * pedía, así que *leer* un documento vacío era una escritura. Un cliente que
   * pintaba el lienzo antes de sincronizar creaba sus propios mapas vacíos y, al
   * conectarse, Yjs resolvía el conflicto a favor de uno de los dos: si ganaba
   * el del recién llegado, el proyecto desaparecía para todos.
   */
  it('leer un documento vacío no destruye el diagrama al sincronizar', () => {
    const servidor = nuevoDoc();
    crearClase(servidor, 'Cliente');
    crearClase(servidor, 'Pedido');

    // El recién llegado dibuja su lienzo vacío antes de recibir nada.
    const reciénLlegado = new Y.Doc();
    expect(Object.keys(readDiagram(reciénLlegado).classes)).toHaveLength(0);
    readDiagram(reciénLlegado);

    // Y ahora sincronizan en ambos sentidos, como al conectarse.
    const delServidor = Y.encodeStateAsUpdate(servidor, Y.encodeStateVector(reciénLlegado));
    const delCliente = Y.encodeStateAsUpdate(reciénLlegado, Y.encodeStateVector(servidor));
    Y.applyUpdate(reciénLlegado, delServidor);
    Y.applyUpdate(servidor, delCliente);

    expect(Object.values(readDiagram(servidor).classes).map((c) => c.name).sort()).toEqual([
      'Cliente',
      'Pedido',
    ]);
    expect(readDiagram(reciénLlegado)).toEqual(readDiagram(servidor));
    expect(readDiagram(servidor).name).toBe('Prueba');
  });

  it('mover y renombrar a la vez no hace que un cambio pise al otro', () => {
    const ana = nuevoDoc();
    const clienteId = crearClase(ana, 'Cliente');

    const beto = new Y.Doc();
    Y.applyUpdate(beto, Y.encodeStateAsUpdate(ana));

    applyOperation(ana, { op: 'moveClass', ref: { id: clienteId }, position: { x: 500, y: 300 } });
    applyOperation(beto, { op: 'renameClass', ref: { id: clienteId }, name: 'Persona' });

    Y.applyUpdate(beto, Y.encodeStateAsUpdate(ana, Y.encodeStateVector(beto)));
    Y.applyUpdate(ana, Y.encodeStateAsUpdate(beto, Y.encodeStateVector(ana)));

    const cliente = readDiagram(ana).classes[clienteId];
    expect(cliente?.name).toBe('Persona');
    expect(cliente?.position).toEqual({ x: 500, y: 300 });
  });

  it('dos clases creadas a la vez sin conexión no se colocan una encima de otra', () => {
    // Converger no basta: si las dos caen en el mismo punto, quien creó la que
    // queda debajo ve desaparecer su trabajo al reconectar y concluye que la
    // fusión se lo comió. El dato está; el problema es que no se ve.
    const ana = nuevoDoc();
    crearClase(ana, 'Cliente');

    const beto = new Y.Doc();
    Y.applyUpdate(beto, Y.encodeStateAsUpdate(ana));

    // Los identificadores se fijan a mano. Yjs los sortea, y dejarlos al azar
    // haría que esta prueba fallara de vez en cuando sin que nadie hubiera
    // tocado nada: lo que se afirma aquí es que dos clientes *distintos* eligen
    // sitios distintos, no que el azar sea amable.
    ana.clientID = 1;
    beto.clientID = 2;

    // Sin conexión: ninguno de los dos ve la clase del otro al elegir sitio.
    const factura = crearClase(ana, 'Factura');
    const almacen = crearClase(beto, 'Almacen');

    Y.applyUpdate(ana, Y.encodeStateAsUpdate(beto, Y.encodeStateVector(ana)));

    const diagrama = readDiagram(ana);
    expect(diagrama.classes[factura]?.position).not.toEqual(diagrama.classes[almacen]?.position);
  });
});

describe('readDiagram', () => {
  it('omite las relaciones cuyo extremo ya no existe en vez de fallar', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Cliente');
    crearClase(doc, 'Pedido');
    applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Cliente' },
      target: { name: 'Pedido' },
      sourceMultiplicity: '1',
      targetMultiplicity: '*',
    });

    // Se borra la clase directamente en el documento, simulando el estado
    // intermedio que produce otra réplica que aún no ha propagado todo.
    const pedidoId = Object.values(readDiagram(doc).classes).find((c) => c.name === 'Pedido')?.id;
    getClassesMap(doc).delete(pedidoId ?? '');

    const diagrama = readDiagram(doc);
    expect(Object.keys(diagrama.relations)).toHaveLength(0);
    expect(Object.keys(diagrama.classes)).toHaveLength(1);
  });
});

describe('edición manual de relaciones', () => {
  /** Deja Cliente y Pedido asociados y devuelve el id de la relación. */
  function conRelacion(
    doc: Y.Doc,
    kind: Extract<Operation, { op: 'addRelation' }>['kind'] = 'association',
    sourceMultiplicity = '1',
    targetMultiplicity = '*',
  ): string {
    crearClase(doc, 'Cliente');
    crearClase(doc, 'Pedido');
    const result = applyOperation(doc, {
      op: 'addRelation',
      kind,
      source: { name: 'Cliente' },
      target: { name: 'Pedido' },
      sourceMultiplicity,
      targetMultiplicity,
    });
    if (!result.ok || !result.relationId) throw new Error('no se pudo crear la relación');
    return result.relationId;
  }

  function relacionDe(doc: Y.Doc, id: string) {
    const relacion = readDiagram(doc).relations[id];
    if (!relacion) throw new Error('la relación desapareció');
    return relacion;
  }

  it('cambia la multiplicidad de un extremo sin tocar el otro', () => {
    const doc = nuevoDoc();
    const id = conRelacion(doc, 'association', '1', '*');

    const result = applyOperation(doc, {
      op: 'updateRelation',
      id,
      changes: { sourceMultiplicity: '0..1' },
    });

    expect(result.ok).toBe(true);
    const relacion = relacionDe(doc, id);
    expect(relacion.source.multiplicity).toBe('0..1');
    // El extremo que nadie tocó se queda como estaba: es lo que permite que dos
    // personas ajusten lados distintos de la misma flecha sin pisarse.
    expect(relacion.target.multiplicity).toBe('*');
  });

  it('convierte un uno a uno en un uno a muchos, que es lo que cambia el JPA generado', () => {
    const doc = nuevoDoc();
    const id = conRelacion(doc, 'association', '1', '1');

    applyOperation(doc, { op: 'updateRelation', id, changes: { targetMultiplicity: '1..*' } });

    const relacion = relacionDe(doc, id);
    expect(isToMany(relacion.source.multiplicity)).toBe(false);
    expect(isToMany(relacion.target.multiplicity)).toBe(true);
  });

  it('conserva el nombre y los roles al cambiar solo la cardinalidad', () => {
    const doc = nuevoDoc();
    const id = conRelacion(doc);
    applyOperation(doc, {
      op: 'updateRelation',
      id,
      changes: { name: 'realiza', sourceRole: 'comprador', targetRole: 'compras' },
    });

    applyOperation(doc, { op: 'updateRelation', id, changes: { targetMultiplicity: '1..*' } });

    const relacion = relacionDe(doc, id);
    expect(relacion.name).toBe('realiza');
    expect(relacion.source.role).toBe('comprador');
    expect(relacion.target.role).toBe('compras');
  });

  it('vaciar un rol lo quita en vez de guardar una cadena vacía', () => {
    const doc = nuevoDoc();
    const id = conRelacion(doc);
    applyOperation(doc, { op: 'updateRelation', id, changes: { sourceRole: 'comprador' } });
    applyOperation(doc, { op: 'updateRelation', id, changes: { sourceRole: '   ' } });

    // Una cadena vacía llegaría al generador como si fuera un nombre de campo.
    expect(relacionDe(doc, id).source.role).toBeUndefined();
  });

  it('al pasar a herencia normaliza las multiplicidades, que ahí no significan nada', () => {
    const doc = nuevoDoc();
    const id = conRelacion(doc, 'association', '1', '*');

    applyOperation(doc, { op: 'updateRelation', id, changes: { kind: 'inheritance' } });

    const relacion = relacionDe(doc, id);
    expect(relacion.kind).toBe('inheritance');
    expect(relacion.source.multiplicity).toBe('1');
    expect(relacion.target.multiplicity).toBe('1');
  });

  it('no deja crear un ciclo convirtiendo una asociación en herencia', () => {
    // El agujero que esta prueba vigila: si `updateRelation` no comprobase el
    // ciclo, bastaría con dibujar asociaciones y convertirlas después para
    // esquivar la validación de `addRelation`. El ciclo aparecería mucho más
    // tarde, como una recursión infinita en el generador.
    const doc = nuevoDoc();
    crearClase(doc, 'A');
    crearClase(doc, 'B');
    applyOperation(doc, {
      op: 'addRelation',
      kind: 'inheritance',
      source: { name: 'B' },
      target: { name: 'A' },
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
    });

    const suelta = applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'A' },
      target: { name: 'B' },
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
    });
    const id = suelta.ok && suelta.relationId ? suelta.relationId : '';

    const result = applyOperation(doc, { op: 'updateRelation', id, changes: { kind: 'inheritance' } });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/ciclo/);
    // Y no se ha quedado a medias: sigue siendo la asociación que era.
    expect(relacionDe(doc, id).kind).toBe('association');
  });

  it('rechaza una relación que no existe', () => {
    const doc = nuevoDoc();
    const result = applyOperation(doc, {
      op: 'updateRelation',
      id: 'no-existe',
      changes: { sourceMultiplicity: '*' },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/No existe la relación/);
  });

  it('describe el cambio en castellano, sin colar el nombre inglés del enum', () => {
    const descripcion = describeOperation({
      op: 'updateRelation',
      id: 'r1',
      changes: { kind: 'composition', sourceMultiplicity: '1', targetMultiplicity: '1..*' },
    });

    expect(descripcion).toContain('composición');
    expect(descripcion).not.toContain('composition');
    expect(descripcion).toContain('1..*');
  });

  it('la descripción de una relación nueva dice la cardinalidad en palabras', () => {
    const descripcion = describeOperation({
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Cliente' },
      target: { name: 'Pedido' },
      sourceMultiplicity: '1',
      targetMultiplicity: '*',
    });

    expect(descripcion).toContain('asociación');
    expect(descripcion).toContain('uno a muchos');
  });

  it('no habla de cardinalidad en una herencia, que no la tiene', () => {
    const descripcion = describeOperation({
      op: 'addRelation',
      kind: 'inheritance',
      source: { name: 'Empleado' },
      target: { name: 'Persona' },
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
    });

    expect(descripcion).toContain('herencia');
    expect(descripcion).not.toContain('uno a uno');
  });
});

describe('asociación de clase rápida (associationClassName en addRelation)', () => {
  // Es el atajo de un solo gesto que ofrece el lienzo: en vez de `addClass` +
  // `setAssociationClass` por separado —que no se pueden encadenar en un
  // mismo array de operaciones porque el segundo necesitaría el id que
  // genera el primero—, `addRelation` crea la clase y la cuelga él mismo.

  it('crea la clase intermedia y la cuelga de la relación cuando es N:M', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Estudiante');
    crearClase(doc, 'Curso');

    const result = applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Estudiante' },
      target: { name: 'Curso' },
      sourceMultiplicity: '*',
      targetMultiplicity: '*',
      associationClassName: 'Inscripcion',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relationId).toBeDefined();
    expect(result.classId).toBeDefined();

    const diagrama = readDiagram(doc);
    const relacion = diagrama.relations[result.relationId as string];
    expect(relacion?.associationClassId).toBe(result.classId);
    const clase = diagrama.classes[result.classId as string];
    expect(clase?.name).toBe('Inscripcion');
    // La clase intermedia es una clase más del diagrama, no un objeto aparte:
    // tiene que poder llevar sus propios atributos igual que cualquier otra.
    expect(clase?.kind).toBe('class');
  });

  it('rechaza el atajo si la cardinalidad resultante no es muchos a muchos', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Estudiante');
    crearClase(doc, 'Curso');

    const result = applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Estudiante' },
      target: { name: 'Curso' },
      sourceMultiplicity: '1',
      targetMultiplicity: '*',
      associationClassName: 'Inscripcion',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/muchos a muchos/);
    // Nada a medias: ni la relación ni la clase deberían haberse creado.
    const diagrama = readDiagram(doc);
    expect(Object.keys(diagrama.relations)).toHaveLength(0);
    expect(Object.keys(diagrama.classes)).toHaveLength(2);
  });

  it('rechaza el atajo sobre una agregación N:M, igual que setAssociationClass', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Estudiante');
    crearClase(doc, 'Curso');

    const result = applyOperation(doc, {
      op: 'addRelation',
      kind: 'aggregation',
      source: { name: 'Estudiante' },
      target: { name: 'Curso' },
      sourceMultiplicity: '*',
      targetMultiplicity: '*',
      associationClassName: 'Inscripcion',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/muchos a muchos/);
  });

  it('sin associationClassName se comporta como una relación normal, sin clase de más', () => {
    const doc = nuevoDoc();
    crearClase(doc, 'Estudiante');
    crearClase(doc, 'Curso');

    const result = applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Estudiante' },
      target: { name: 'Curso' },
      sourceMultiplicity: '*',
      targetMultiplicity: '*',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.classId).toBeUndefined();
    expect(Object.keys(readDiagram(doc).classes)).toHaveLength(2);
  });

  it('rechaza el atajo si ya existe una clase con ese nombre, en vez de crear una segunda', () => {
    // Bug real: el asistente propuso crear la relación con clase de
    // asociación «DetalleVenta» cuando ya había una clase con ese nombre en
    // el diagrama. `addRelation` creaba una segunda clase homónima sin
    // avisar, y el `addAttribute` del mismo lote que apuntaba a
    // «DetalleVenta» por nombre encontraba dos y fallaba con un error que no
    // mencionaba la colisión real («Hay 2 clases llamadas...»); como el lote
    // se revierte entero, pulsar «Aplicar» no hacía nada visible.
    const doc = nuevoDoc();
    crearClase(doc, 'Estudiante');
    crearClase(doc, 'Curso');
    crearClase(doc, 'Inscripcion');

    const result = applyOperation(doc, {
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Estudiante' },
      target: { name: 'Curso' },
      sourceMultiplicity: '*',
      targetMultiplicity: '*',
      associationClassName: 'Inscripcion',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Ya existe una clase llamada «Inscripcion»');
    // Nada a medias, tampoco en este caso: ni la relación ni una segunda
    // «Inscripcion» deberían haberse creado.
    const diagrama = readDiagram(doc);
    expect(Object.keys(diagrama.relations)).toHaveLength(0);
    expect(Object.keys(diagrama.classes)).toHaveLength(3);
  });

  it('la descripción menciona la clase de asociación creada', () => {
    const descripcion = describeOperation({
      op: 'addRelation',
      kind: 'association',
      source: { name: 'Estudiante' },
      target: { name: 'Curso' },
      sourceMultiplicity: '*',
      targetMultiplicity: '*',
      associationClassName: 'Inscripcion',
    });

    expect(descripcion).toContain('clase de asociación');
    expect(descripcion).toContain('Inscripcion');
  });
});
