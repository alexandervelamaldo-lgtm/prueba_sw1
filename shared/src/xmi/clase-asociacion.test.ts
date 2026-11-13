import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyOperations } from '../crdt/operations.js';
import { initializeEmpty, readDiagram } from '../crdt/document.js';
import { createClass, createDiagram, createRelation, withClass, withRelation } from '../model/factory.js';
import type { ClassDiagram } from '../model/uml.js';
import { diagramaAXmi } from './export.js';
import { leerXmi } from './import.js';
import { attr, descendientes, parseXml, type XmlNode } from './xml.js';

/**
 * Bug real: una clase de asociación (la «clase intermedia» de una N:M) se
 * exportaba como una clase suelta más un `uml:Association` aparte, sin
 * ningún enlace entre las dos. Enterprise Architect no tiene manera de
 * reconstruir desde ahí la clase de asociación: la dibuja flotando, sin la
 * línea discontinua a la relación. Estas pruebas cubren tanto la forma del
 * XML que se exporta (el `uml:AssociationClass` del estándar) como que
 * reimportarlo reconstruye el mismo enlace en el modelo interno.
 */
function diagramaConClaseDeAsociacion(): ClassDiagram {
  const estudiante = createClass({ id: 'ESTUDIANTE', name: 'Estudiante', position: { x: 0, y: 0 } });
  const curso = createClass({ id: 'CURSO', name: 'Curso', position: { x: 300, y: 0 } });
  const inscripcion = createClass({
    id: 'INSCRIPCION',
    name: 'Inscripcion',
    position: { x: 150, y: 200 },
  });

  let d = createDiagram({ name: 'Academia' });
  for (const c of [estudiante, curso, inscripcion]) d = withClass(d, c);
  d = withRelation(
    d,
    createRelation({
      id: 'R1',
      kind: 'association',
      sourceId: 'ESTUDIANTE',
      targetId: 'CURSO',
      sourceMultiplicity: '*',
      targetMultiplicity: '*',
      associationClassId: 'INSCRIPCION',
    }),
  );
  return d;
}

function raiz(diagrama: ClassDiagram): XmlNode {
  const r = parseXml(diagramaAXmi(diagrama));
  if (!r.ok) throw new Error('el exportador ha producido XML inválido');
  return r.root;
}

describe('clase de asociación — exportación a XMI', () => {
  it('se escribe como uml:AssociationClass y no como clase suelta más asociación aparte', () => {
    const root = raiz(diagramaConClaseDeAsociacion());

    const asociaciones = descendientes(root, 'packagedElement').filter(
      (n) => attr(n, 'xmi:type') === 'uml:AssociationClass',
    );
    expect(asociaciones).toHaveLength(1);
    expect(attr(asociaciones[0]!, 'name')).toBe('Inscripcion');

    // No hay un `uml:Association` suelto para este enlace: la propia clase es
    // la asociación. Solo las clases normales se escriben como `uml:Class`.
    const clasesNormales = descendientes(root, 'packagedElement')
      .filter((n) => attr(n, 'xmi:type') === 'uml:Class')
      .map((n) => attr(n, 'name'));
    expect(clasesNormales).toEqual(['Estudiante', 'Curso']);
    expect(
      descendientes(root, 'packagedElement').filter((n) => attr(n, 'xmi:type') === 'uml:Association'),
    ).toHaveLength(0);
  });

  it('cuelga sus dos extremos de sí misma, uniendo las dos clases', () => {
    const root = raiz(diagramaConClaseDeAsociacion());
    const claseDeAsociacion = descendientes(root, 'packagedElement').find(
      (n) => attr(n, 'xmi:type') === 'uml:AssociationClass',
    )!;

    const extremos = descendientes(claseDeAsociacion, 'ownedEnd');
    expect(extremos).toHaveLength(2);
    const idsApuntados = extremos.map((e) => attr(descendientes(e, 'type')[0]!, 'xmi:idref'));
    expect(idsApuntados).toEqual(['id_ESTUDIANTE', 'id_CURSO']);
  });
});

describe('clase de asociación — reimportación', () => {
  it('reconstruye la misma clase de asociación colgada de la misma relación N:M', () => {
    const xmi = diagramaAXmi(diagramaConClaseDeAsociacion());
    const resultado = leerXmi(xmi, createDiagram({ name: 'Otro' }));

    expect(resultado.aplicable).toBe(true);
    expect(resultado.avisos.filter((a) => a.severidad === 'error')).toEqual([]);

    // La clase de asociación no debe traer su propio `addClass`: la crea el
    // atajo de `addRelation`, o colisionaría con esa misma operación.
    const addClassDeInscripcion = resultado.operaciones.filter(
      (o) => o.op === 'addClass' && o.name === 'Inscripcion',
    );
    expect(addClassDeInscripcion).toHaveLength(0);

    const relacion = resultado.operaciones.find(
      (o) => o.op === 'addRelation' && o.associationClassName === 'Inscripcion',
    );
    expect(relacion).toBeDefined();
    if (relacion?.op !== 'addRelation') throw new Error('no se importó la relación con clase de asociación');
    expect(relacion.source).toEqual({ name: 'Estudiante' });
    expect(relacion.target).toEqual({ name: 'Curso' });
    expect(relacion.sourceMultiplicity).toBe('*');
    expect(relacion.targetMultiplicity).toBe('*');

    // Y aplicando esas operaciones sobre un documento vacío, el modelo interno
    // vuelve a enlazar la clase con la relación, que es justo lo que el
    // visor/generador necesita para tratarla como clase de asociación.
    const doc = new Y.Doc();
    initializeEmpty(doc, { name: 'Otro', basePackage: 'com.ejemplo.otro', artifactId: 'otro' });
    const aplicado = applyOperations(doc, resultado.operaciones);
    expect(aplicado.ok).toBe(true);

    const diagrama = readDiagram(doc);
    const relacionAplicada = Object.values(diagrama.relations).find((r) => r.kind === 'association');
    expect(relacionAplicada).toBeDefined();
    const claseDeAsociacion = diagrama.classes[relacionAplicada!.associationClassId ?? ''];
    expect(claseDeAsociacion?.name).toBe('Inscripcion');
  });
});
