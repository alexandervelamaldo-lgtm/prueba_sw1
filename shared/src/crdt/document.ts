import * as Y from 'yjs';
import { ulid } from '../model/id.js';
import type {
  Attribute,
  ClassDiagram,
  ClassKind,
  Method,
  SeedRow,
  UmlClass,
  UmlModule,
  UmlRelation,
  Visibility,
} from '../model/uml.js';

/**
 * Enlace entre el documento CRDT y el modelo canónico UML.
 *
 * Vive en `shared` y no en el frontend por una razón que no es de comodidad: el
 * servidor lee el mismo documento para generar el backend, y si cada lado
 * interpretase la estructura a su manera, el código generado podría no
 * corresponder a lo que el usuario tiene en pantalla (RNF-MAN-04).
 *
 * Decisiones de estructura, todas orientadas a que dos ediciones simultáneas no
 * se destruyan entre sí:
 *
 * - Clases y relaciones son `Y.Map` indexados por identificador, no arrays. Dos
 *   usuarios que crean una clase a la vez escriben claves distintas y ambas
 *   sobreviven; con un array, ambos insertarían en la misma posición.
 * - La posición se guarda como dos números sueltos (`x`, `y`) y no como un
 *   objeto. Yjs resuelve conflictos por clave: si fuera un objeto, mover y
 *   redimensionar a la vez haría que un cambio pisara al otro.
 * - Los atributos sí son `Y.Array`, porque su orden es información: es el orden
 *   en que se muestran y en que se generan los campos.
 */

/**
 * Los tres mapas son *tipos raíz* de Yjs, no mapas anidados dentro de uno.
 *
 * La diferencia separa un diagrama que se conserva de uno que se pierde. Un
 * mapa anidado hay que crearlo, y crearlo es una escritura: si dos réplicas
 * hacen `raiz.set('clases', new Y.Map())` sin haberse visto, Yjs resuelve el
 * conflicto quedándose con una sola, y la que pierde se lleva por delante todas
 * las clases que colgaban de ella. Bastaba con que un cliente *dibujara* un
 * diagrama vacío antes de sincronizar —cualquier lectura creaba los mapas que
 * faltaban— para que al conectarse borrase el proyecto de todos los demás.
 *
 * `doc.getMap(nombre)` sobre un tipo raíz no es una escritura: no genera
 * actualización, no se propaga y devuelve el mismo objeto en todas las
 * réplicas. El conflicto deja de ser improbable y pasa a ser imposible.
 */
const CLASSES = 'diagrama.clases';
const RELATIONS = 'diagrama.relaciones';
const MODULES = 'diagrama.modulos';
const META = 'diagrama.meta';
/**
 * Los diagramas de comunicación importados de un XMI.
 *
 * El nombre se declara aquí, con los otros cuatro, aunque lo que se guarda
 * dentro lo escriba `comunicaciones.ts`. Es a propósito: la única forma de
 * garantizar que dos tipos raíz no chocan es tener la lista entera delante, y
 * una clave repetida haría que dos estructuras distintas se escribieran sobre
 * el mismo objeto Yjs, que es un fallo que no se ve hasta que el documento ya
 * está corrupto en el disco de todos.
 */
const COMMUNICATIONS = 'diagrama.comunicaciones';

export function getClassesMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(CLASSES);
}

export function getRelationsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(RELATIONS);
}

/**
 * Los módulos, en su propio tipo raíz y no dentro de `meta`.
 *
 * Por lo mismo que se explica arriba: si colgaran de un mapa anidado, dos
 * réplicas que crean su primer módulo sin haberse visto perderían una de las
 * dos listas enteras. Un documento anterior a los módulos no tiene esta clave y
 * tampoco la necesita: `getMap` sobre un tipo raíz que no existe devuelve uno
 * vacío sin escribir nada, así que los proyectos ya guardados se abren igual.
 */
export function getModulesMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(MODULES);
}

export function getMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(META);
}

/**
 * Los diagramas de comunicación importados, indexados por su `xmi:id`.
 *
 * Vale la misma regla que para los módulos, y por el mismo motivo: un proyecto
 * guardado antes de que esto existiera no tiene la clave y no la necesita.
 * `getMap` sobre un tipo raíz que no existe devuelve uno vacío sin escribir
 * nada, así que los documentos que ya están en disco y en PostgreSQL se abren
 * sin migración y sin tocar el `DocumentStore`, que guarda el documento entero
 * como un blob opaco y no interpreta su contenido.
 */
export function getCommunicationsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(COMMUNICATIONS);
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

function readString(map: Y.Map<unknown>, key: string, fallback = ''): string {
  const value = map.get(key);
  return typeof value === 'string' ? value : fallback;
}

function readNumber(map: Y.Map<unknown>, key: string, fallback: number): number {
  const value = map.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(map: Y.Map<unknown>, key: string, fallback: boolean): boolean {
  const value = map.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readAttribute(map: Y.Map<unknown>): Attribute {
  return {
    id: readString(map, 'id') || ulid(),
    name: readString(map, 'name', 'campo'),
    type: {
      name: readString(map, 'type', 'String'),
      collection: readBoolean(map, 'collection', false),
    },
    visibility: (readString(map, 'visibility', '-') as Visibility) || '-',
    multiplicity: (map.get('multiplicity') as string | undefined) ?? undefined,
    defaultValue: (map.get('defaultValue') as string | undefined) ?? undefined,
    isStatic: readBoolean(map, 'isStatic', false),
    isFinal: readBoolean(map, 'isFinal', false),
    isIdentifier: readBoolean(map, 'isIdentifier', false),
    isUnique: readBoolean(map, 'isUnique', false),
    isNullable: readBoolean(map, 'isNullable', true),
  };
}

function readMethod(map: Y.Map<unknown>): Method {
  const rawParameters = map.get('parameters');
  const parameters =
    rawParameters instanceof Y.Array
      ? rawParameters.toArray().flatMap((entry) => {
          if (!(entry instanceof Y.Map)) return [];
          return [
            {
              name: readString(entry, 'name', 'parametro'),
              type: {
                name: readString(entry, 'type', 'String'),
                collection: readBoolean(entry, 'collection', false),
              },
            },
          ];
        })
      : [];

  const returnTypeName = map.get('returnType');

  return {
    id: readString(map, 'id') || ulid(),
    name: readString(map, 'name', 'metodo'),
    parameters,
    returnType:
      typeof returnTypeName === 'string' && returnTypeName.length > 0
        ? { name: returnTypeName, collection: readBoolean(map, 'returnCollection', false) }
        : null,
    visibility: (readString(map, 'visibility', '+') as Visibility) || '+',
    isStatic: readBoolean(map, 'isStatic', false),
    isAbstract: readBoolean(map, 'isAbstract', false),
  };
}

/**
 * Lee una fila de datos iniciales.
 *
 * Se descarta cualquier valor que no sea cadena en lugar de convertirlo. Un
 * número que llegara aquí vendría de una réplica que escribe distinto, y
 * convertirlo a texto disimularía esa divergencia hasta que apareciese en el SQL
 * generado con un formato inesperado.
 */
function readSeedRow(map: Y.Map<unknown>): SeedRow {
  const row: SeedRow = {};
  for (const [key, value] of map.entries()) {
    if (typeof value === 'string') row[key] = value;
  }
  return row;
}

function readClass(map: Y.Map<unknown>): UmlClass {
  const attributes = map.get('attributes');
  const methods = map.get('methods');
  const literals = map.get('literals');
  const seedRows = map.get('seedRows');
  const stereotype = map.get('stereotype');
  const moduleId = map.get('moduleId');

  return {
    id: readString(map, 'id'),
    name: readString(map, 'name', 'Clase'),
    kind: (readString(map, 'kind', 'class') as ClassKind) || 'class',
    stereotype: typeof stereotype === 'string' && stereotype ? stereotype : undefined,
    attributes:
      attributes instanceof Y.Array
        ? attributes.toArray().flatMap((a) => (a instanceof Y.Map ? [readAttribute(a)] : []))
        : [],
    methods:
      methods instanceof Y.Array
        ? methods.toArray().flatMap((m) => (m instanceof Y.Map ? [readMethod(m)] : []))
        : [],
    literals:
      literals instanceof Y.Array
        ? literals.toArray().filter((l): l is string => typeof l === 'string')
        : [],
    position: { x: readNumber(map, 'x', 0), y: readNumber(map, 'y', 0) },
    size: { w: readNumber(map, 'w', 220), h: readNumber(map, 'h', 120) },
    transient: readBoolean(map, 'transient', false),
    seedRows:
      seedRows instanceof Y.Array
        ? seedRows.toArray().flatMap((r) => (r instanceof Y.Map ? [readSeedRow(r)] : []))
        : [],
    moduleId: typeof moduleId === 'string' && moduleId.length > 0 ? moduleId : null,
  };
}

function readModule(map: Y.Map<unknown>): UmlModule {
  return {
    id: readString(map, 'id'),
    name: readString(map, 'name', 'Módulo'),
    packageSegment: readString(map, 'packageSegment', 'modulo'),
    description: readString(map, 'description', ''),
  };
}

function readRelation(map: Y.Map<unknown>): UmlRelation {
  const name = map.get('name');
  const sourceRole = map.get('sourceRole');
  const targetRole = map.get('targetRole');
  const associationClassId = map.get('associationClassId');

  return {
    id: readString(map, 'id'),
    kind: readString(map, 'kind', 'association') as UmlRelation['kind'],
    name: typeof name === 'string' && name ? name : undefined,
    source: {
      classId: readString(map, 'sourceId'),
      role: typeof sourceRole === 'string' && sourceRole ? sourceRole : undefined,
      multiplicity: readString(map, 'sourceMultiplicity', '1'),
      navigable: readBoolean(map, 'sourceNavigable', true),
    },
    target: {
      classId: readString(map, 'targetId'),
      role: typeof targetRole === 'string' && targetRole ? targetRole : undefined,
      multiplicity: readString(map, 'targetMultiplicity', '1'),
      navigable: readBoolean(map, 'targetNavigable', true),
    },
    associationClassId:
      typeof associationClassId === 'string' && associationClassId ? associationClassId : undefined,
  };
}

/**
 * Proyecta el documento CRDT al modelo canónico.
 *
 * Es tolerante a propósito: un documento colaborativo puede contener estados
 * intermedios —una relación cuyo extremo acaba de borrarse, un campo que otro
 * cliente aún no ha sincronizado— y fallar aquí dejaría el lienzo en blanco. La
 * validación estricta ocurre después, en el generador, donde sí debe bloquear.
 */
export function readDiagram(doc: Y.Doc): ClassDiagram {
  const meta = getMetaMap(doc);
  const classesMap = getClassesMap(doc);
  const relationsMap = getRelationsMap(doc);
  const modulesMap = getModulesMap(doc);

  const modules: Record<string, UmlModule> = {};
  for (const [id, value] of modulesMap.entries()) {
    if (!(value instanceof Y.Map)) continue;
    modules[id] = { ...readModule(value), id };
  }

  const classes: Record<string, UmlClass> = {};
  for (const [id, value] of classesMap.entries()) {
    if (!(value instanceof Y.Map)) continue;
    const cls = readClass(value);
    classes[id] = { ...cls, id };
  }

  const relations: Record<string, UmlRelation> = {};
  for (const [id, value] of relationsMap.entries()) {
    if (!(value instanceof Y.Map)) continue;
    const relation = readRelation(value);
    // Una relación con un extremo ya borrado no es representable: se omite en
    // lugar de propagar un identificador colgante al generador.
    if (!classes[relation.source.classId] || !classes[relation.target.classId]) continue;
    // Una clase de asociación que apunta a una clase ya borrada sí es
    // representable como relación corriente: se limpia solo ese campo, no toda
    // la relación, igual que el borrado de un módulo deja huérfano el `moduleId`
    // de una clase en lugar de borrar la clase entera.
    const associationClassId =
      relation.associationClassId && classes[relation.associationClassId]
        ? relation.associationClassId
        : undefined;
    relations[id] = { ...relation, id, associationClassId };
  }

  return {
    id: readString(meta, 'id') || doc.guid,
    name: readString(meta, 'name', 'Diagrama sin título'),
    classes,
    relations,
    modules,
    meta: {
      basePackage: readString(meta, 'basePackage', 'com.ejemplo.proyecto'),
      artifactId: readString(meta, 'artifactId', 'proyecto'),
      description: readString(meta, 'description', ''),
      createdAt: (meta.get('createdAt') as string | undefined) ?? undefined,
      updatedAt: (meta.get('updatedAt') as string | undefined) ?? undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

function writeAttribute(attribute: Attribute): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', attribute.id);
  map.set('name', attribute.name);
  map.set('type', attribute.type.name);
  map.set('collection', attribute.type.collection);
  map.set('visibility', attribute.visibility);
  if (attribute.multiplicity) map.set('multiplicity', attribute.multiplicity);
  if (attribute.defaultValue) map.set('defaultValue', attribute.defaultValue);
  map.set('isStatic', attribute.isStatic);
  map.set('isFinal', attribute.isFinal);
  map.set('isIdentifier', attribute.isIdentifier);
  map.set('isUnique', attribute.isUnique);
  map.set('isNullable', attribute.isNullable);
  return map;
}

function writeMethod(method: Method): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', method.id);
  map.set('name', method.name);
  map.set('visibility', method.visibility);
  map.set('isStatic', method.isStatic);
  map.set('isAbstract', method.isAbstract);
  map.set('returnType', method.returnType?.name ?? '');
  map.set('returnCollection', method.returnType?.collection ?? false);

  const parameters = new Y.Array<unknown>();
  for (const parameter of method.parameters) {
    const entry = new Y.Map<unknown>();
    entry.set('name', parameter.name);
    entry.set('type', parameter.type.name);
    entry.set('collection', parameter.type.collection);
    parameters.push([entry]);
  }
  map.set('parameters', parameters);
  return map;
}

export function writeClass(cls: UmlClass): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', cls.id);
  map.set('name', cls.name);
  map.set('kind', cls.kind);
  if (cls.stereotype) map.set('stereotype', cls.stereotype);
  map.set('x', cls.position.x);
  map.set('y', cls.position.y);
  map.set('w', cls.size.w);
  map.set('h', cls.size.h);
  map.set('transient', cls.transient);
  // Solo se escribe si hay módulo. Un `moduleId: null` explícito en cada clase
  // haría que todo diagrama existente cambiara de estado al abrirse.
  if (cls.moduleId !== null) map.set('moduleId', cls.moduleId);

  const attributes = new Y.Array<unknown>();
  attributes.push(cls.attributes.map(writeAttribute));
  map.set('attributes', attributes);

  const methods = new Y.Array<unknown>();
  methods.push(cls.methods.map(writeMethod));
  map.set('methods', methods);

  const literals = new Y.Array<unknown>();
  literals.push([...cls.literals]);
  map.set('literals', literals);

  const seedRows = new Y.Array<unknown>();
  seedRows.push(cls.seedRows.map(writeSeedRow));
  map.set('seedRows', seedRows);

  return map;
}

export function writeSeedRow(row: SeedRow): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(row)) map.set(key, value);
  return map;
}

export function writeModule(modulo: UmlModule): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', modulo.id);
  map.set('name', modulo.name);
  map.set('packageSegment', modulo.packageSegment);
  map.set('description', modulo.description);
  return map;
}

export function writeRelation(relation: UmlRelation): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', relation.id);
  map.set('kind', relation.kind);
  if (relation.name) map.set('name', relation.name);
  map.set('sourceId', relation.source.classId);
  map.set('sourceMultiplicity', relation.source.multiplicity);
  map.set('sourceNavigable', relation.source.navigable);
  if (relation.source.role) map.set('sourceRole', relation.source.role);
  map.set('targetId', relation.target.classId);
  map.set('targetMultiplicity', relation.target.multiplicity);
  map.set('targetNavigable', relation.target.navigable);
  if (relation.target.role) map.set('targetRole', relation.target.role);
  // Solo se escribe si existe: así una relación corriente no arrastra la clave
  // vacía y `readRelation` puede seguir usando "ausencia de clave" como señal
  // de "esta relación no tiene clase de asociación".
  if (relation.associationClassId) map.set('associationClassId', relation.associationClassId);
  return map;
}

/**
 * Vuelca un diagrama completo sobre el documento.
 *
 * Reemplaza el contenido: solo debe usarse al crear un proyecto o al importar.
 * Aplicarlo sobre un documento compartido borraría el trabajo de los demás, ya
 * que los borrados en un CRDT también son cambios que se propagan.
 */
export function initializeDiagram(doc: Y.Doc, diagram: ClassDiagram): void {
  doc.transact(() => {
    const meta = getMetaMap(doc);
    meta.set('id', diagram.id);
    meta.set('name', diagram.name);
    meta.set('basePackage', diagram.meta.basePackage);
    meta.set('artifactId', diagram.meta.artifactId);
    meta.set('description', diagram.meta.description);
    meta.set('createdAt', diagram.meta.createdAt ?? new Date().toISOString());

    const modules = getModulesMap(doc);
    for (const key of [...modules.keys()]) modules.delete(key);
    for (const modulo of Object.values(diagram.modules)) {
      modules.set(modulo.id, writeModule(modulo));
    }

    const classes = getClassesMap(doc);
    for (const key of [...classes.keys()]) classes.delete(key);
    for (const cls of Object.values(diagram.classes)) {
      classes.set(cls.id, writeClass(cls));
    }

    const relations = getRelationsMap(doc);
    for (const key of [...relations.keys()]) relations.delete(key);
    for (const relation of Object.values(diagram.relations)) {
      relations.set(relation.id, writeRelation(relation));
    }
  }, 'inicializacion');
}

/** Documento vacío pero utilizable: con metadatos y sin clases. */
export function initializeEmpty(
  doc: Y.Doc,
  init: { name: string; basePackage: string; artifactId: string; description?: string },
): void {
  doc.transact(() => {
    const meta = getMetaMap(doc);
    meta.set('id', doc.guid);
    meta.set('name', init.name);
    meta.set('basePackage', init.basePackage);
    meta.set('artifactId', init.artifactId);
    meta.set('description', init.description ?? '');
    meta.set('createdAt', new Date().toISOString());
    getClassesMap(doc);
    getRelationsMap(doc);
    getModulesMap(doc);
  }, 'inicializacion');
}
